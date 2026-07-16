-- Reconcile the users table for databases created before later columns were
-- added to 001_init.sql.
--
-- Migrations run exactly once (tracked in schema_migrations), so editing an
-- already-applied 001_init.sql never adds the new columns to an existing
-- database. A database initialised early can therefore be missing columns the
-- current code references (e.g. client_key, user_group), which made
-- "add user" (INSERT into users ...) fail with a 500.
--
-- This migration re-adds every users column idempotently (ADD COLUMN IF NOT
-- EXISTS), so any older database is brought up to the current schema without
-- touching data. It is a no-op on databases that already have the columns.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash      TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role               TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE users ADD COLUMN IF NOT EXISTS name               TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS user_group         TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS projects           JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS client_key         TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS archived           BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS archived_reason    TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_by         TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_token       TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_expires     TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret         TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled        BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_pending_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at         TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at      TIMESTAMPTZ;
