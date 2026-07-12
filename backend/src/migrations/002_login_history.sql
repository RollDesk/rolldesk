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
