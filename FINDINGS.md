# FINDINGS.md — Step 0 API verification

Verified 2026-05-31 against the Aircall developer docs and JobNimbus Public API
docs. The developer portals block automated fetching (HTTP 403), so the facts
below were confirmed from Aircall/JobNimbus documentation surfaced via search.
**Anything I could not confirm verbatim is called out under "Open questions /
risks" — the code is written defensively around those.**

---

## Aircall API

### Auth
- **Basic Auth.** `Authorization: Basic base64(api_id:api_token)`.
  `api_id` = username, `api_token` = password. Credentials come from the Aircall
  Dashboard. OAuth also exists but is only needed for multi-account/public
  integrations — for a single Aircall account, Basic Auth is sufficient. We use
  Basic Auth.
- Base URL: `https://api.aircall.io/v1/`.

### Rate limits
- Documented at **60 requests/minute per API key** (general REST limit). The API
  returns `429 Too Many Requests` when exceeded. We centralize all outbound
  calls through a token-bucket rate limiter (default 60/min, configurable) and
  honor `Retry-After` on 429.

### Webhooks
- **Envelope shape** (confirmed): every webhook POST body is
  ```json
  {
    "resource": "call",
    "event": "call.created",
    "timestamp": 1716200000,
    "token": "<per-webhook token>",
    "data": { ... the resource ... }
  }
  ```
- **Event names** (confirmed): `call.created`, `call.ringing_on_agent`,
  `call.agent_declined`, `call.answered`, `call.transferred`,
  `call.unsuccessful_transfer`, `call.hungup`, `call.ended`,
  `call.voicemail_left`, `call.assigned`, `call.archived`, `call.tagged`,
  `call.untagged`, `call.commented`. Contact events: `contact.created`,
  `contact.updated`, `contact.deleted`.
  - `call.hungup` fires immediately at call end (data may be incomplete).
  - **`call.ended`** fires once all call data is gathered (recording, duration),
    typically ~30s after the call. We key the transcript poll fallback off this.
- **Transcription event**: **`transcription.created`** — pushed via webhook,
  **but only available with the Aircall AI / "AI Assist" add-on.** Without that
  add-on there is no transcript at all (API or webhook). This is a hard
  dependency and is documented in the README.
- **Authenticity**: Aircall signs the request with **HMAC-SHA1**, secret = your
  API token, value delivered in the **`X-Aircall-Signature`** header. The body
  also carries a per-webhook **`token`** that should match the value shown when
  the webhook was created. We verify **both**: the `token` in the body
  (constant-time compare against `AIRCALL_WEBHOOK_SECRET`) and, when configured,
  the HMAC-SHA1 signature against the raw body. Unauthenticated requests are
  rejected with 401.

### Transcription retrieval
- **`GET /v1/calls/:call_id/transcription`** (confirmed endpoint). Requires AI
  Assist. Returns the transcript once processing completes; before that it can
  404 / return empty — hence the poll-with-backoff fallback. Response groups
  text by speaker/utterance; we treat the exact field layout defensively (see
  risks) and flatten to plain text for the note.

### Call / contact phone fields
- **Call object** exposes `data.raw_digits` = the **external** party's number in
  pretty format (e.g. `"+1 800-123-4567"`), plus `direction`
  (`inbound`/`outbound`), `started_at`, `answered_at`, `ended_at`, `duration`
  (seconds), `user`/agent info, `number` (the Aircall line — NOT the customer).
  We extract the customer number from `raw_digits` and normalize to E.164.
- **Contact object** exposes `phone_numbers: [{ label, value }]` and similarly
  `emails`. We normalize every `value` to E.164.

---

## JobNimbus Public API

### Auth & base URL
- Base URL: **`https://app.jobnimbus.com/api1/`** (confirmed).
- **API-key auth** via `Authorization: Bearer <API_KEY>` header. Key generated
  in **Settings > API** in the JobNimbus web app.
- Supported methods: **GET / POST / PUT only** (no DELETE, no PATCH) — confirmed.

### Contacts
- `GET /api1/contacts` — list/search. Supports a **`filter`** query param that
  takes an **Elasticsearch-style JSON query** (URL-encoded), e.g. filtering by a
  term. Individual record: `GET /api1/contacts/:jnid`.
- `POST /api1/contacts` — create a contact.
- `PUT /api1/contacts/:jnid` — update a contact.
- Phone fields on a contact: `mobile_phone`, `home_phone`, `work_phone`, `fax`
  (string fields). The record id is `jnid`.

### Activities / notes
- `POST /api1/activities` — create an activity. Key fields: `note` (body text),
  `record_type_name` / `type`, and a `related` array linking to the contact via
  its `jnid` (e.g. `[{ "id": "<jnid>", "type": "contact" }]`). Returned object
  carries its own `jnid`, which we store as `jobnimbus_activity_id`.

### Merge endpoint
- **There is NO contact-merge endpoint in the JobNimbus Public API.** Confirmed
  by absence in the documented surface (only GET/POST/PUT on contacts). Per the
  task, we therefore implement **dedup-on-write**: search by normalized phone
  before any write; update on single match, create on no match, and **flag (do
  not auto-resolve)** on multiple matches. `ENABLE_MERGE_ENDPOINT` is provided
  as a config flag defaulting to OFF for the day JobNimbus ships a real one.

---

## Open questions / risks (handled defensively in code)

1. **JobNimbus `filter` syntax.** The exact Elasticsearch query JSON for an
   exact phone match is not fully documented publicly. `clients/jobnimbus.ts`
   isolates query construction in one place (`buildPhoneFilter`) so it can be
   adjusted without touching flow logic, and after the server-side filter we
   **re-verify every candidate client-side** by normalizing each of the
   contact's phone fields to E.164 and exact-comparing — so a too-broad or
   too-narrow server filter never causes a wrong write.
2. **Phone field set on JobNimbus contacts.** We read/compare
   `mobile_phone`, `home_phone`, `work_phone` and write to `mobile_phone` by
   default (configurable list in `clients/jobnimbus.ts`).
3. **Transcription response shape.** Flattening is centralized in
   `flattenTranscript()` and tolerates several plausible shapes
   (`{transcription:{content:{...}}}`, array of utterances, plain string).
4. **Aircall webhook signature algorithm.** We verify the body `token`
   unconditionally and the `X-Aircall-Signature` HMAC-SHA1 when
   `AIRCALL_VERIFY_HMAC=true`; if Aircall's mechanism differs for your account,
   flip that flag and the token check still protects the endpoint.
5. **Rate limits** for JobNimbus are not clearly published; we default to a
   conservative 100/min, configurable via env.

None of the required capabilities are missing except a contact-merge endpoint,
which is expected and handled by dedup-on-write as the task specifies. No
blocker — safe to build.

---

## Addendum — extra requirements (recording upload + estimate-signed Slack)

These were added after Step 0. Confirmed surfaces:

### Call recording → JobNimbus job
- **Recording URL**: present on the call object (`data.recording`) on
  `call.ended` and via `GET /v1/calls/:id`. The transcript flow fetches the call
  by id to get a consistent recording URL + metadata (direction, duration,
  agent, `raw_digits`) rather than trusting the lighter webhook payload.
- **JobNimbus file upload**: `POST /api1/files` (a.k.a. "Create Attachment").
  Accepts the file plus `related`/`type` linkage (`contact` | `job`) and
  `filename`/`description`. We download the Aircall recording (authenticated
  Basic Auth GET on the recording URL) and upload it as multipart to the matched
  **related job** (fallback: the contact). There is also a "Create a File from
  URL" variant; we use the multipart upload since the Aircall URL is
  access-controlled. **Exact field names for `/files` are isolated in
  `clients/jobnimbus.ts#uploadFile` (risk flagged).**
- **Jobs lookup**: jobs are reachable via `GET /api1/jobs` and relate to a
  contact through the `related` array / `related.id = <contact jnid>`. We find
  the contact by phone, then resolve its related job(s).

### Estimate "fully signed" → Slack shoutout (client = SkyRights)
- **Trigger**: a **JobNimbus webhook/automation** fires when an estimate's
  signature status becomes signed. We expose **`POST /webhooks/jobnimbus`**,
  verify a shared secret (`JOBNIMBUS_WEBHOOK_SECRET`), and look at the estimate
  object. Estimate statuses: draft, sent, approved, denied, invoiced, void; a
  separate **Signature Status** indicates the customer signature. We treat
  "fully signed" as signature status signed/complete (matched via a configurable
  set, `ESTIMATE_SIGNED_STATUSES`).
- **Amount**: estimate `total` field. **Sales rep**: `sales_rep_name` (fallback
  `sales_rep`). **Customer/job**: estimate `related` contact/job display name.
- **Slack**: posted via the Slack Web API (`chat.postMessage`) using
  `SLACK_BOT_TOKEN` to `SLACK_CHANNEL_ID`. Both are **deploy-time env vars** — no
  Slack workspace is touched during development. Idempotency via
  `processed_estimates` so a re-fired webhook never double-posts.
- **Risk**: JobNimbus webhook payload shape for estimates is not fully
  documented; parsing is isolated in `webhooks/jobnimbus.ts` + the
  `EstimateWebhook` zod schema and tolerant of `data`-wrapped vs flat bodies.
