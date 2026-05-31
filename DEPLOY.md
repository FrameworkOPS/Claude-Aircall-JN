# Deploying to Railway

Clean project name: **`aircall-jobnimbus`**.

The repo ships with a `Dockerfile` and `railway.json` so a deploy builds the
image, runs DB migrations, and starts the service (web + worker) with `/health`
as the healthcheck.

## Option A — one-command script (recommended)

```bash
# A Railway token: Railway → Account Settings → Tokens (account token lets the
# script create the project; a project token deploys into an existing project).
export RAILWAY_TOKEN=xxxxxxxx

# Optional: export your secrets so the script can push them too.
export AIRCALL_API_ID=... AIRCALL_API_TOKEN=... AIRCALL_WEBHOOK_SECRET=...
export JOBNIMBUS_API_KEY=... JOBNIMBUS_WEBHOOK_SECRET=...
export SLACK_BOT_TOKEN=... SLACK_CHANNEL_ID=...

./scripts/deploy.sh --with-vars     # init + provision Postgres + push vars + deploy
# or, to set vars later in the dashboard:
./scripts/deploy.sh
```

What it does: installs the Railway CLI if needed → `railway init --name
aircall-jobnimbus` → adds the PostgreSQL plugin → (optionally) sets runtime
variables → `railway up` → prints the public domain.

## Option B — one-click button

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new)

Choose **Deploy from GitHub repo**, pick `FrameworkOPS/Claude-Aircall-JN`, name
the project `aircall-jobnimbus`, add the **PostgreSQL** plugin, then set the
environment variables below.

## Option C — manual CLI

```bash
railway login
railway init --name aircall-jobnimbus
railway add --database postgres
railway up
railway domain
```

## Required environment variables

`DATABASE_URL` is provided by the Railway Postgres plugin. Set the rest
(see `.env.example` for the full annotated list):

| Variable | Required | Notes |
| --- | --- | --- |
| `AIRCALL_API_ID`, `AIRCALL_API_TOKEN` | ✅ | Aircall Basic Auth |
| `AIRCALL_WEBHOOK_SECRET` | ✅ | webhook body token |
| `JOBNIMBUS_API_KEY` | ✅ | Settings → API |
| `JOBNIMBUS_WEBHOOK_SECRET` | ✅ | shared secret for estimate webhook |
| `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID` | for Flow 3 | client Slack workspace |
| `DATABASE_SSL` | ✅ on Railway | set to `require` |
| `DEFAULT_PHONE_REGION` | optional | default `US` |
| `ATTACH_TARGET` | optional | default `job` |

## After deploy

1. `railway domain` → copy the public URL.
2. Register Aircall webhook → `https://<domain>/webhooks/aircall`
   (events: `contact.created`, `contact.updated`, `call.ended`).
3. Register JobNimbus estimate-signed automation →
   `https://<domain>/webhooks/jobnimbus` (send the shared secret as the
   `X-Webhook-Secret` header).
4. Confirm `GET https://<domain>/health` returns `{ "status": "ok" }`.
