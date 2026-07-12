-- Authentication: the users table backing the first-run setup wizard, password
-- login and TOTP MFA. There is no default/seeded account — the first admin is
-- created via the setup wizard, and the app stays locked until one exists.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin',
  -- Base32 TOTP secret. Set (pending) during MFA enrollment; mfa_enabled flips
  -- to true only once the user has verified a code from their authenticator.
  mfa_secret    TEXT,
  mfa_enabled   BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (lower(email));
