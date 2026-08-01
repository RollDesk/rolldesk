-- Backfill api_tokens on databases created before it existed.
--
-- api_tokens was added to 001_init.sql after that migration had already run on
-- some instances. The ledger records filenames, not content, so the edited file
-- was never re-applied and those databases have no api_tokens table: every call
-- to /api/tokens fails with `relation "api_tokens" does not exist`, and the
-- API-token section of the profile is permanently broken. This migration adds
-- the table where it is missing and is a no-op where 001 already created it —
-- which is why the definition below must stay byte-identical to the one in 001.
--
-- The lesson, not the fix: never edit an applied migration. Add a new one.
CREATE TABLE IF NOT EXISTS api_tokens (
  id           BIGSERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT,                 -- optional human label ("CI pipeline", ...)
  token_hash   TEXT NOT NULL UNIQUE, -- SHA-256 hex of the raw token
  prefix       TEXT NOT NULL,        -- masked form for display (e.g. rd_live_ab••••1234)
  expires_at   TIMESTAMPTZ,          -- NULL = never expires
  last_used_at TIMESTAMPTZ,          -- updated (best-effort) on each authenticated call
  revoked_at   TIMESTAMPTZ,          -- set when the user revokes it
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens (user_id, created_at DESC);
