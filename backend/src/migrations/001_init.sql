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
--
-- Tables at a glance:
--   projects       — one row per project (its apps, environments, targets, defaults).
--   deployments    — one row per rollout record (schedule, status, comments, approval).
--   users          — login accounts (password + TOTP MFA); the auth source of truth.
--   login_history  — per-user sign-in log shown in the profile.
--   attachments    — uploaded files (raw bytes), each linked to a deployment.
--   audit_log      — append-only change history shown in the Audit view.
--   app_state      — key/value store for a few whole-collection UI settings
--                    (user roster, client list, notification recipients).

-- A project belongs to a client and defines what/where it deploys. The columns
-- are just for listing/filtering; the full editable object (apps, test
-- environments, production targets/locations, people, approval policy, etc.)
-- lives in `data` (JSONB) so the UI can evolve its shape without a migration.
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

-- One rollout record. Filterable columns (project/env/status/internal) sit
-- next to the full deployment object in `data` (JSONB) — schedule, targets,
-- assignee, client approval, comments/timeline, changelog, attachment ref, etc.
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

-- Login accounts (the authentication source of truth). Created by the first-run
-- setup wizard and password/MFA login; separate from the UI "user roster"
-- (people shown in the Users tab), which lives in app_state under key 'roster'.
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

-- Append-only change history ("who did what, when"), shown in the Audit view.
-- One row per action (e.g. created a project, changed a deployment, added a
-- user). Written via POST /api/audit and never updated or deleted.
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

-- Generic key/value store (one JSONB blob per named collection) for UI settings
-- that are small and edited as a whole, so they don't each need their own table.
-- Read/written via GET/PUT /api/state/:key with last-write-wins semantics.
-- Known keys:
--   'roster'        — the Users-tab people list (name, email, role, projects,
--                     invite/archived flags). Distinct from the `users` table,
--                     which holds actual login accounts.
--   'clients'       — the client list (key, display name, e-mail domain).
--   'notifications' — notification recipients: { emails: [...], teams: [...] }
--                     with per-event toggles (e.g. Teams webhook URLs).
CREATE TABLE IF NOT EXISTS app_state (
  key        TEXT PRIMARY KEY,   -- collection name: 'roster' | 'clients' | 'notifications'
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,  -- the whole collection (array or object)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
