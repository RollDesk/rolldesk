-- Persistence for application state the single-page UI used to keep only in
-- browser memory: the change history (audit log) and a few whole-collection
-- settings (the user roster, the client list, and notification recipients).
--
-- The audit log is append-only, so it gets a real table with one row per event.
-- The other collections are small, edited as a whole, and already saved
-- last-write-wins on the client (like projects/deployments), so they live in a
-- generic key/value table (one JSONB row per named collection) to avoid a
-- bespoke table + endpoint per entity.

CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  ts         TEXT,           -- human-readable timestamp captured on the client
  actor      TEXT,
  role       TEXT,
  action     TEXT,
  entity     TEXT,
  detail     TEXT,
  project    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS app_state (
  key        TEXT PRIMARY KEY,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
