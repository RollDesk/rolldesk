-- RollDesk initial schema (consolidated).
--
-- Deployments and projects are stored as a full object (JSONB) plus columns for
-- filtering. Authentication lives in `users` (first-run setup wizard, password
-- login and TOTP MFA). There is no default/seeded account — the first admin is
-- created via the setup wizard, and the app stays locked until one exists.
--
-- This migration is schema-only. Client/project sample data is NOT committed —
-- it lives in local, uncommitted test data (see backend/src/seeds/). Load it
-- with `npm run seed`.

CREATE TABLE IF NOT EXISTS projects (
  key            TEXT PRIMARY KEY,
  client_name    TEXT NOT NULL,
  name           TEXT NOT NULL,
  default_days   INTEGER NOT NULL DEFAULT 5,
  default_time   TEXT NOT NULL DEFAULT '20:00',
  client_visible BOOLEAN NOT NULL DEFAULT true,
  data           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deployments (
  id           TEXT PRIMARY KEY,
  project_key  TEXT NOT NULL,
  env          TEXT,
  status       TEXT,
  internal     BOOLEAN NOT NULL DEFAULT false,
  data         JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deployments_project ON deployments (project_key);
CREATE INDEX IF NOT EXISTS idx_deployments_status  ON deployments (status);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin',
  -- Base32 TOTP secret. Set (pending) during MFA enrollment; mfa_enabled flips
  -- to true only once the user has verified a code from their authenticator.
  mfa_secret         TEXT,
  mfa_enabled        BOOLEAN NOT NULL DEFAULT false,
  -- Holds a newly generated secret while re-configuring MFA from the profile,
  -- until the user confirms a code. Only then does it replace mfa_secret, so an
  -- abandoned reconfigure never locks the user out of their existing app.
  mfa_pending_secret TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (lower(email));

-- Persistent sign-in history. A row is recorded whenever a full session token
-- is issued (first-login MFA enrollment and subsequent MFA logins), so the
-- profile can show real login history that survives refreshes and restarts.
CREATE TABLE IF NOT EXISTS login_history (
  id           BIGSERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  logged_in_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip           TEXT,
  user_agent   TEXT
);

CREATE INDEX IF NOT EXISTS idx_login_history_user
  ON login_history (user_id, logged_in_at DESC);

-- File attachments stored directly in the database. The changelog file attached
-- when scheduling a deployment (and any future per-deployment file) is kept here
-- as raw bytes (BYTEA) alongside its filename and MIME type. Attachments belong
-- to a deployment and are removed automatically when that deployment is deleted.
CREATE TABLE IF NOT EXISTS attachments (
  id            BIGSERIAL PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  mime          TEXT NOT NULL DEFAULT 'application/octet-stream',
  byte_size     INTEGER NOT NULL,
  content       BYTEA NOT NULL,
  uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attachments_deployment
  ON attachments (deployment_id, uploaded_at);

-- Persistence for application state the single-page UI used to keep only in
-- browser memory: the append-only change history (audit log) and a few
-- whole-collection settings (user roster, client list, notification recipients)
-- stored last-write-wins in a generic key/value table.
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
