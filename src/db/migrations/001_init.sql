-- Aircall <-> JobNimbus integration schema.
-- Idempotent: safe to run repeatedly.

-- Raw inbound webhook events, persisted before any processing so nothing is
-- ever lost if the worker is down.
CREATE TABLE IF NOT EXISTS webhook_events (
  id          BIGSERIAL PRIMARY KEY,
  source      TEXT        NOT NULL,            -- 'aircall' | 'jobnimbus'
  event_type  TEXT        NOT NULL,            -- e.g. 'call.ended'
  payload     JSONB       NOT NULL,
  signature   TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_received_at ON webhook_events (received_at);

-- DB-backed job queue with retry/backoff and dead-lettering.
CREATE TABLE IF NOT EXISTS jobs (
  id           BIGSERIAL PRIMARY KEY,
  type         TEXT        NOT NULL,           -- 'contact_sync' | 'recording' | 'estimate_shoutout'
  payload      JSONB       NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'pending', -- pending|processing|done|dead
  attempts     INT         NOT NULL DEFAULT 0,
  max_attempts INT         NOT NULL DEFAULT 6,
  run_after    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error   TEXT,
  dedupe_key   TEXT,                            -- enqueue idempotency
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_dedupe_key ON jobs (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_claimable ON jobs (status, run_after) WHERE status = 'pending';

-- Aircall contact <-> JobNimbus contact mapping (Flow 1 dedup).
CREATE TABLE IF NOT EXISTS contact_map (
  aircall_contact_id TEXT        NOT NULL,
  jobnimbus_jnid     TEXT        NOT NULL,
  normalized_phone   TEXT        NOT NULL,
  last_synced_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (aircall_contact_id, normalized_phone)
);
CREATE INDEX IF NOT EXISTS idx_contact_map_phone ON contact_map (normalized_phone);
CREATE INDEX IF NOT EXISTS idx_contact_map_jnid  ON contact_map (jobnimbus_jnid);

-- Idempotency for recording upload (Flow 2). One row per call.
CREATE TABLE IF NOT EXISTS processed_calls (
  aircall_call_id      TEXT        PRIMARY KEY,
  normalized_phone     TEXT,
  jobnimbus_jnid       TEXT,                    -- contact or job the recording landed on
  jobnimbus_activity_id TEXT,
  jobnimbus_file_id    TEXT,
  recording_uploaded_at TIMESTAMPTZ,
  outcome              TEXT,                    -- 'posted' | 'no_contact_match' | 'duplicate_conflict'
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency for the signed-estimate Slack shoutout.
CREATE TABLE IF NOT EXISTS processed_estimates (
  estimate_jnid    TEXT        PRIMARY KEY,
  signed_amount    NUMERIC,
  slack_channel    TEXT,
  slack_ts         TEXT,
  slack_posted_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
