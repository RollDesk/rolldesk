-- Supports re-configuring MFA from the profile: a newly generated secret is
-- held here (pending) until the user confirms a code from their authenticator.
-- Only then does it replace the active mfa_secret, so an abandoned reconfigure
-- never locks the user out of their existing authenticator.

ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_pending_secret TEXT;
