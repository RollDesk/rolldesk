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
--   users          — user accounts + directory (login/password/TOTP MFA plus
--                    name, role, project access, invitations); source of truth.
--   login_history  — per-user sign-in log shown in the profile.
--   attachments    — uploaded files (raw bytes), each linked to a deployment.
--   audit_log      — append-only change history shown in the Audit view.
--   app_state      — key/value store for a few whole-collection UI settings
--                    (client list, notification recipients).
--   api_tokens     — personal access tokens (hashed) for the automation API.
--   sso_providers  — per-domain OIDC single sign-on configuration (Azure/Google
--                    /generic), managed by an admin; IdP secret encrypted.

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

-- User accounts — the single source of truth for both authentication AND the
-- Users directory shown in the app. The first admin is created by the setup
-- wizard; further users are invited by an admin (name/role/projects set here,
-- password_hash left NULL until they accept the invitation and set their own
-- password, then enroll TOTP MFA on first login).
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  -- NULL until an invited user sets their password via the invitation link.
  password_hash TEXT,
  role          TEXT NOT NULL DEFAULT 'admin',  -- 'admin' | 'rm' | 'installer' | 'client'
  name          TEXT,                            -- display name for the directory
  projects      JSONB NOT NULL DEFAULT '[]'::jsonb,  -- project keys an installer/client may access
  client_key    TEXT,                            -- for 'client' users: the client they belong to
  archived         BOOLEAN NOT NULL DEFAULT false, -- soft-delete: keeps history, blocks sign-in
  archived_reason  TEXT,
  invited_by       TEXT,                          -- email/name of the admin who invited them
  -- Invitation / password-reset: SHA-256 hash of a single-use token embedded in
  -- the invite link, and its expiry. Cleared once the password has been set.
  invite_token   TEXT,
  invite_expires TIMESTAMPTZ,
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

CREATE INDEX IF NOT EXISTS idx_users_invite ON users (invite_token) WHERE invite_token IS NOT NULL;

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
--   'clients'       — the client list (key, display name, e-mail domain).
--   'notifications' — notification recipients: { emails: [...], teams: [...] }
--                     with per-event toggles (e.g. Teams webhook URLs).
CREATE TABLE IF NOT EXISTS app_state (
  key        TEXT PRIMARY KEY,   -- collection name: 'clients' | 'notifications'
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,  -- the whole collection (array or object)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Personal access tokens for the automation API. The raw token (prefix `rd_`)
-- is shown to the user exactly once at creation; only its SHA-256 hash is
-- stored here, so a database leak never exposes usable tokens. A token
-- authenticates API calls as its owning user until it is revoked or expires.
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

-- Single sign-on (OIDC) providers, configurable per e-mail domain by an admin.
-- Maps a domain (e.g. 'dxc.com') to an OpenID Connect provider (Microsoft Entra
-- ID / Azure AD, Google, or a generic issuer). When enabled, users of that
-- domain sign in through the IdP instead of a password (the account must already
-- exist — no just-in-time provisioning); local admins keep password login as a
-- fallback. The IdP client secret is stored ENCRYPTED (AES-256-GCM, see
-- backend/src/sso.js) and is never returned to the frontend.
CREATE TABLE IF NOT EXISTS sso_providers (
  id                 SERIAL PRIMARY KEY,
  domain             TEXT NOT NULL UNIQUE,          -- lowercased e-mail domain
  provider           TEXT NOT NULL DEFAULT 'azure', -- 'azure' | 'google' | 'oidc'
  issuer             TEXT NOT NULL,                 -- OIDC issuer / discovery base URL
  client_id          TEXT NOT NULL,
  client_secret_enc  TEXT,                          -- AES-256-GCM ciphertext (base64)
  enabled            BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sso_providers_domain ON sso_providers (lower(domain));
