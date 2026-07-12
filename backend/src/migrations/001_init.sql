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
