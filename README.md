# Aircall ⇄ JobNimbus Integration

A single Node.js/TypeScript service (deployed on Railway) that replaces a
Zapier flow between **Aircall** and **JobNimbus**, plus a Slack sales shoutout.
It runs unattended and handles real customer data, so it is built with
idempotency, retries with backoff, rate limiting, and structured logging.

## What it does

| Flow | Trigger | Action |
| --- | --- | --- |
| **1. Contact sync + dedup** | Aircall `contact.created` / `contact.updated` | Match JobNimbus contact by normalized phone → **update** if one match, **create** if none, **flag `DUPLICATE_CONFLICT`** (no write) if many. |
| **2. Call transcript + recording → JobNimbus** | Aircall `transcription.created` (or poll after `call.ended`) | Match contact by the customer's phone, find the related **job** (fallback to contact), attach a machine-tagged **note** with the transcript, and **upload the recording** as a file. |
| **3. Signed-estimate Slack shoutout** | JobNimbus webhook when an estimate is signed | Post a sales shoutout (rep, customer/job, signed $ amount) to a configured Slack channel. |

### What "merge" means here

The JobNimbus Public API has **no contact-merge endpoint** (see `FINDINGS.md`).
"Merge" in this system = **dedup-on-write + conflict flagging**: we never create
a duplicate, and when a phone matches multiple existing contacts we log
`DUPLICATE_CONFLICT` with both `jnid`s and **skip the write** so a human can
resolve it. Auto-merging would risk data loss, so it is intentionally not done.
`ENABLE_MERGE_ENDPOINT` exists (default OFF) for the day JobNimbus ships a real
merge API.

## Architecture

```
Aircall ─┐                            ┌─ JobNimbus (contacts, jobs, notes, files, estimates)
JobNimbus┘─► POST /webhooks/* ─► webhook_events ─► jobs (DB queue) ─► worker ─► flows ─┤
                 (verify, 200 fast)                                                    └─ Slack
```

- **Webhook receiver** (`/webhooks/aircall`, `/webhooks/jobnimbus`): verifies
  authenticity, validates with `zod`, persists the raw event, enqueues a job,
  and returns **200 immediately** — no slow work in the handler.
- **Worker loop**: claims due jobs (`FOR UPDATE SKIP LOCKED`), runs the flow,
  and on failure retries with exponential backoff + jitter, then dead-letters.
  Runs in the web process by default (`RUN_WORKER_IN_WEB=true`) or as a separate
  Railway service.
- **Idempotency tables**: `contact_map`, `processed_calls`, `processed_estimates`
  — every external write checks these first, so nothing is ever double-posted.
- **Phone matching** is always on normalized **E.164** (`libphonenumber-js`),
  never a raw string compare.

Module layout: `clients/{aircall,jobnimbus,slack}`, `flows/`, `lib/phone`,
`lib/httpClient` (rate-limited + retry), `lib/verify`, `webhooks/`, `worker/`,
`db/` (pool, repo, migrations).

## Prerequisites

- **Aircall AI Assist add-on** — *required*. Without it there are no
  transcripts (neither the `transcription.created` webhook nor the
  `GET /v1/calls/:id/transcription` endpoint return anything).
- Node.js 20+, a PostgreSQL database (Railway Postgres plugin).

## Setup

### 1. Aircall API credentials
Aircall Dashboard → **Integrations / API Keys** → create an API key. You get an
**API ID** and **API Token** (Basic Auth). Put them in `AIRCALL_API_ID` /
`AIRCALL_API_TOKEN`.

### 2. Register the Aircall webhook
Aircall Dashboard → create a Webhook integration pointing at
`https://<your-railway-domain>/webhooks/aircall`. Subscribe to:
`contact.created`, `contact.updated`, `transcription.created`, and `call.ended`
(the last only needed if you use poll mode). Copy the webhook **token** shown on
creation into `AIRCALL_WEBHOOK_SECRET`. To additionally verify the
`X-Aircall-Signature` HMAC-SHA1 header, set `AIRCALL_VERIFY_HMAC=true`.

### 3. JobNimbus API key
JobNimbus → **Settings → API** → create an API key → `JOBNIMBUS_API_KEY`.

### 4. JobNimbus estimate-signed webhook
JobNimbus → **Automations** → on estimate signed/approved, add a webhook action
posting to `https://<your-railway-domain>/webhooks/jobnimbus`. Send the shared
secret either as an `X-Webhook-Secret` header or a `?secret=` query param, and
set the same value in `JOBNIMBUS_WEBHOOK_SECRET`. The payload should include the
estimate `jnid` and its signature/status.

### 5. Slack (sales shoutout)
Create a Slack app in the **client workspace** with `chat:write`, install it,
and copy the bot token (`xoxb-…`) → `SLACK_BOT_TOKEN`. Set `SLACK_CHANNEL_ID` to
the target channel ID (e.g. `C0123ABC` — in Slack, channel → View details →
copy the ID at the bottom). If Slack is left unconfigured, the estimate flow
records the event but skips posting.

## Configuration (env vars)

See `.env.example` for the full annotated list. Key ones:

| Var | Default | Notes |
| --- | --- | --- |
| `AIRCALL_API_ID` / `AIRCALL_API_TOKEN` | — | Basic Auth |
| `AIRCALL_WEBHOOK_SECRET` | — | webhook body token |
| `AIRCALL_VERIFY_HMAC` | `false` | also check `X-Aircall-Signature` |
| `TRANSCRIPT_DELIVERY` | `event` | `event` \| `poll` \| `both` |
| `TRANSCRIPT_POLL_SCHEDULE_MIN` | `1,3,5,10` | poll-mode backoff (minutes) |
| `JOBNIMBUS_API_KEY` | — | Settings → API |
| `JOBNIMBUS_WEBHOOK_SECRET` | — | shared secret for estimate webhook |
| `ATTACH_TARGET` | `job` | `job` (fallback contact) \| `contact` \| `both` |
| `ESTIMATE_SIGNED_STATUSES` | `signed,complete,completed` | counts as fully signed |
| `SLACK_BOT_TOKEN` / `SLACK_CHANNEL_ID` | — | client workspace |
| `DEFAULT_PHONE_REGION` | `US` | for numbers without a country code |
| `CREATE_CONTACT_FROM_TRANSCRIPT` | `false` | create a contact when none matches |
| `ENABLE_MERGE_ENDPOINT` | `false` | reserved; no JN merge API today |
| `MAX_RETRIES` | `6` | per-job retry cap before dead-letter |
| `RUN_WORKER_IN_WEB` | `true` | run worker in web process |
| `DATABASE_URL` / `DATABASE_SSL` | — | `require` for managed PG |

## Local development

```bash
cp .env.example .env      # fill in values; point DATABASE_URL at local Postgres
npm install
npm run migrate           # apply SQL migrations
npm run dev               # web + worker with hot reload
npm test                  # unit + integration tests
npm run typecheck
```

## Deploy to Railway

1. Create a Railway project and add the **PostgreSQL** plugin (provides
   `DATABASE_URL`). Set `DATABASE_SSL=require`.
2. Set all env vars from `.env.example` in the Railway service.
3. Deploy:
   ```bash
   railway up
   ```
   The container runs migrations then starts the service (`railway.json` /
   `Dockerfile` `startCommand`). Health check: `GET /health`.
4. (Optional) For higher volume, set `RUN_WORKER_IN_WEB=false` and add a second
   Railway service from the same repo with start command
   `node dist/db/migrate.js && node dist/worker/index.js`.
5. Register the webhook URLs (steps 2 & 4 above) using the deployed domain.

## Reliability notes

- **Rate limiting**: all outbound calls go through a per-upstream token-bucket
  limiter (`AIRCALL_RATE_LIMIT_PER_MIN`, `JOBNIMBUS_RATE_LIMIT_PER_MIN`).
- **Backoff**: exponential + jitter on 429/5xx, honoring `Retry-After`; capped,
  then dead-lettered with the payload preserved in the `jobs` table.
- **Logging**: structured JSON (`pino`). Phone numbers are logged as last-4
  only; transcripts and notes are never logged.

## Out of scope (by design)

- Two-way sync JobNimbus → Aircall (this is one-directional).
- Historical backfill of past calls/transcripts. A backfill would hook in by
  enqueuing `transcript` jobs (one per historical `call_id`) via `Repo.enqueueJob`.
- Any UI.

See `FINDINGS.md` for the confirmed API facts and the open questions/risks that
the code handles defensively.
