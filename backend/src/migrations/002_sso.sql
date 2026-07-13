-- Single sign-on (OIDC) providers, configurable per e-mail domain by an admin.
--
-- Each row maps an e-mail domain (e.g. 'dxc.com') to an OpenID Connect identity
-- provider (Microsoft Entra ID / Azure AD, Google, or a generic OIDC issuer).
-- When a domain has an enabled provider, users of that domain sign in through
-- the IdP instead of a password (their account must already exist — there is no
-- just-in-time provisioning). Local admins keep password login as a fallback.
--
-- The IdP client secret is stored ENCRYPTED (AES-256-GCM, see backend/src/sso.js)
-- and is never returned to the frontend.
CREATE TABLE IF NOT EXISTS sso_providers (
  id                 SERIAL PRIMARY KEY,
  domain             TEXT NOT NULL UNIQUE,          -- lowercased e-mail domain, e.g. 'dxc.com'
  provider           TEXT NOT NULL DEFAULT 'azure', -- 'azure' | 'google' | 'oidc'
  issuer             TEXT NOT NULL,                 -- OIDC issuer / discovery base URL
  client_id          TEXT NOT NULL,
  client_secret_enc  TEXT,                          -- AES-256-GCM ciphertext (base64), never exposed
  enabled            BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sso_providers_domain ON sso_providers (lower(domain));
