// Single sign-on (OIDC) support: per-domain identity-provider configuration
// (Microsoft Entra ID / Azure AD, Google, or a generic OIDC issuer), IdP client
// secret encryption at rest, provider discovery via `openid-client`, and the
// short-lived in-memory stores that carry an SSO login across the redirect to
// the IdP and back.
//
// The functions that touch the identity provider are kept here so the routes in
// routes/auth.js and routes/sso.js stay thin. State lives in this process (no
// external store), which — like the in-memory rate limiter — is enough for a
// single backend instance.
import crypto from 'node:crypto';
import * as client from 'openid-client';
import { query } from './db.js';
import { config } from './config.js';

export const SSO_PROVIDERS = new Set(['azure', 'google', 'oidc']);
const STATE_TTL_MS = 10 * 60 * 1000; // authorization round-trip window: 10 min
const HANDOFF_TTL_MS = 60 * 1000;    // one-time session handoff code: 60 s

// --- Secret encryption (AES-256-GCM) -------------------------------------
// The 32-byte key is derived (via SHA-256) from SSO_ENC_KEY, or from JWT_SECRET
// as a development fallback. Hashing lets the operator provide the key in any
// format (hex/base64/passphrase) without worrying about its exact length.
function encryptionKey() {
  const raw = config.sso.encKey || (config.auth.jwtSecret ? 'rolldesk-sso:' + config.auth.jwtSecret : '');
  if (!raw) {
    throw new Error('SSO secret encryption key unavailable — set SSO_ENC_KEY (or JWT_SECRET).');
  }
  return crypto.createHash('sha256').update(raw).digest();
}

export function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptSecret(stored) {
  const buf = Buffer.from(String(stored), 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// --- Helpers -------------------------------------------------------------

export function emailDomain(email) {
  const m = /@([^@\s]+)$/.exec(String(email || '').trim().toLowerCase());
  return m ? m[1] : null;
}

// The redirect URI must exactly match what is registered in the IdP. A single
// callback path serves every domain/provider; the state store correlates the
// response back to the right one.
export function ssoRedirectUri() {
  return `${config.appBaseUrl}/api/auth/sso/callback`;
}

// Build the OIDC issuer URL from the admin's input for known providers, or use a
// supplied issuer for a generic OIDC provider.
export function computeIssuer(provider, { tenant, issuer } = {}) {
  if (provider === 'azure') {
    const t = String(tenant || '').trim();
    if (!t) throw new Error('Tenant ID is required for Azure');
    return `https://login.microsoftonline.com/${encodeURIComponent(t)}/v2.0`;
  }
  if (provider === 'google') return 'https://accounts.google.com';
  const url = String(issuer || '').trim().replace(/\/+$/, '');
  if (!url) throw new Error('Issuer URL is required');
  return url;
}

// --- Provider persistence ------------------------------------------------

export function serializeProvider(row) {
  return {
    id: row.id,
    domain: row.domain,
    provider: row.provider,
    issuer: row.issuer,
    clientId: row.client_id,
    enabled: !!row.enabled,
    hasSecret: !!row.client_secret_enc,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listProviders() {
  const { rows } = await query('SELECT * FROM sso_providers ORDER BY domain');
  return rows;
}

export async function getProviderById(id) {
  const { rows } = await query('SELECT * FROM sso_providers WHERE id = $1', [id]);
  return rows[0] || null;
}

// The enabled provider for a domain, or null. Used both by the login screen
// (to offer SSO) and by /login enforcement.
export async function getEnabledProviderByDomain(domain) {
  if (!domain) return null;
  const { rows } = await query(
    'SELECT * FROM sso_providers WHERE lower(domain) = lower($1) AND enabled = true',
    [domain]
  );
  return rows[0] || null;
}

// --- IdP discovery -------------------------------------------------------
// openid-client Configuration objects are cached per provider row and
// invalidated when the row (issuer/client/secret) changes.
const discoCache = new Map(); // id -> { key, config }

export async function getOidcConfig(row) {
  const cacheKey = `${row.id}:${row.updated_at}:${row.issuer}:${row.client_id}`;
  const hit = discoCache.get(row.id);
  if (hit && hit.key === cacheKey) return hit.config;
  const secret = row.client_secret_enc ? decryptSecret(row.client_secret_enc) : undefined;
  const cfg = await client.discovery(new URL(row.issuer), row.client_id, secret);
  discoCache.set(row.id, { key: cacheKey, config: cfg });
  return cfg;
}

export function invalidateOidcConfig(id) {
  discoCache.delete(id);
}

// --- Authorization-request state store -----------------------------------
// Carries PKCE verifier + nonce + which provider between /sso/start and the
// /sso/callback the IdP redirects the browser to.
const stateStore = new Map();

function sweep(store) {
  const now = Date.now();
  for (const [k, v] of store) if (v.exp < now) store.delete(k);
}

export function saveState(state, data) {
  sweep(stateStore);
  stateStore.set(state, { ...data, exp: Date.now() + STATE_TTL_MS });
}

export function takeState(state) {
  const v = stateStore.get(state);
  if (!v) return null;
  stateStore.delete(state);
  return v.exp < Date.now() ? null : v;
}

// --- One-time session handoff --------------------------------------------
// The callback runs on the backend and cannot write the SPA's localStorage, so
// it stashes the freshly-minted session JWT behind a single-use code and
// redirects to #/sso/<code>; the SPA exchanges the code for the token.
const handoffStore = new Map();

export function saveHandoff(token) {
  sweep(handoffStore);
  const code = crypto.randomBytes(24).toString('hex');
  handoffStore.set(code, { token, exp: Date.now() + HANDOFF_TTL_MS });
  return code;
}

export function takeHandoff(code) {
  const v = handoffStore.get(code);
  if (!v) return null;
  handoffStore.delete(code);
  return v.exp < Date.now() ? null : v.token;
}

// Build the IdP authorization URL and record the round-trip state.
export async function buildLoginRedirect(row) {
  const cfg = await getOidcConfig(row);
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();
  const nonce = client.randomNonce();
  saveState(state, { codeVerifier, nonce, state, domain: row.domain.toLowerCase(), providerId: row.id });
  const url = client.buildAuthorizationUrl(cfg, {
    redirect_uri: ssoRedirectUri(),
    scope: 'openid email profile',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  return url.href;
}

// Complete the code exchange for a callback and return the verified e-mail.
export async function completeLogin(row, currentUrl, saved) {
  const cfg = await getOidcConfig(row);
  const tokens = await client.authorizationCodeGrant(cfg, currentUrl, {
    pkceCodeVerifier: saved.codeVerifier,
    expectedNonce: saved.nonce,
    expectedState: saved.state,
    idTokenExpected: true,
  });
  const claims = tokens.claims() || {};
  const email = String(claims.email || claims.preferred_username || '').trim().toLowerCase();
  return { email, claims };
}
