#!/usr/bin/env bash
#
# One-command Railway deploy for the Aircall ⇄ JobNimbus integration.
#
# Prereqs (set as environment variables before running):
#   RAILWAY_TOKEN          - Railway account or project token (required)
#   RAILWAY_PROJECT_NAME   - clean project name (default: aircall-jobnimbus)
#
# Secrets the SERVICE needs at runtime (set them in the Railway dashboard, or
# export them and pass --with-vars to push them via this script):
#   AIRCALL_API_ID AIRCALL_API_TOKEN AIRCALL_WEBHOOK_SECRET
#   JOBNIMBUS_API_KEY JOBNIMBUS_WEBHOOK_SECRET
#   SLACK_BOT_TOKEN SLACK_CHANNEL_ID
#
# Usage:
#   RAILWAY_TOKEN=xxx ./scripts/deploy.sh            # init + provision PG + deploy
#   RAILWAY_TOKEN=xxx ./scripts/deploy.sh --with-vars # also push exported secrets
set -euo pipefail

PROJECT_NAME="${RAILWAY_PROJECT_NAME:-aircall-jobnimbus}"
WITH_VARS="${1:-}"

if [[ -z "${RAILWAY_TOKEN:-}" ]]; then
  echo "ERROR: RAILWAY_TOKEN is not set. Create one in Railway → Account/Project → Tokens." >&2
  exit 1
fi

# 1. Ensure the Railway CLI is available.
if ! command -v railway >/dev/null 2>&1; then
  echo "Installing Railway CLI..."
  npm install -g @railway/cli >/dev/null 2>&1
fi
echo "Railway CLI: $(railway --version)"

# 2. Link or create the project with the clean name.
if ! railway status >/dev/null 2>&1; then
  echo "Creating Railway project '${PROJECT_NAME}'..."
  railway init --name "${PROJECT_NAME}"
fi

# 3. Provision PostgreSQL (idempotent; ignore if it already exists).
echo "Ensuring PostgreSQL plugin..."
railway add --database postgres >/dev/null 2>&1 || railway add -d postgres >/dev/null 2>&1 || \
  echo "  (postgres already present or add skipped)"

# 4. Optionally push runtime secrets from the current environment.
if [[ "${WITH_VARS}" == "--with-vars" ]]; then
  echo "Pushing runtime variables..."
  set_var() { [[ -n "${2:-}" ]] && railway variables --set "$1=$2" >/dev/null; }
  set_var AIRCALL_API_ID        "${AIRCALL_API_ID:-}"
  set_var AIRCALL_API_TOKEN     "${AIRCALL_API_TOKEN:-}"
  set_var AIRCALL_WEBHOOK_SECRET "${AIRCALL_WEBHOOK_SECRET:-}"
  set_var JOBNIMBUS_API_KEY     "${JOBNIMBUS_API_KEY:-}"
  set_var JOBNIMBUS_WEBHOOK_SECRET "${JOBNIMBUS_WEBHOOK_SECRET:-}"
  set_var SLACK_BOT_TOKEN       "${SLACK_BOT_TOKEN:-}"
  set_var SLACK_CHANNEL_ID      "${SLACK_CHANNEL_ID:-}"
  railway variables --set "DATABASE_SSL=require" >/dev/null
fi

# 5. Build (Dockerfile) + deploy. Migrations run at container start.
echo "Deploying..."
railway up --ci

# 6. Surface the public URL for webhook registration.
railway domain || true
echo "Done. Register the Aircall/JobNimbus webhooks at the URL above (/webhooks/aircall, /webhooks/jobnimbus)."
