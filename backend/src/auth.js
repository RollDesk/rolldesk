// Authentication helpers: password hashing, JWT signing/verification and TOTP
// MFA. The functions here are pure (no DB, no Express) so they can be unit
// tested in isolation; the Express middleware at the bottom wires them in — and
// is the one place that reads the database, because a session's role is the
// account's current role rather than whatever the token was minted with
// (liveAuthDecision holds that rule, and is pure like the rest).
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { authenticator } from 'otplib';
import qrcode from 'qrcode';
import { config } from './config.js';
// The one piece of I/O in this module: a session's role is read from the account
// on every request rather than trusted from the token (see requireStage).
import { query } from './db.js';

const SALT_ROUNDS = 10;

// --- API access tokens ---------------------------------------------------
// Personal access tokens for the automation API. The raw value is a random,
// URL-safe string prefixed with `rd_live_` so it's recognisable in logs/headers
// and easy to distinguish from a JWT. Only the SHA-256 hash is ever stored.

export const API_TOKEN_PREFIX = 'rd_live_';

export function generateApiToken() {
  const raw = API_TOKEN_PREFIX + crypto.randomBytes(24).toString('hex');
  return { raw, hash: hashApiToken(raw), masked: maskApiToken(raw) };
}

export function sha256hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function hashApiToken(raw) {
  return sha256hex(raw);
}

// Single-use invitation / password-reset token. The raw value goes in the
// emailed link; only its hash is stored, so a DB leak can't be used to hijack
// an invitation.
export function generateInviteToken() {
  const raw = crypto.randomBytes(24).toString('hex');
  return { raw, hash: sha256hex(raw) };
}

// Human-friendly, non-secret representation for listing (keeps the prefix and
// last 4 chars; hides the middle).
export function maskApiToken(raw) {
  const s = String(raw);
  if (s.length <= 12) return s;
  return s.slice(0, API_TOKEN_PREFIX.length + 2) + '••••' + s.slice(-4);
}

export function isApiToken(value) {
  return typeof value === 'string' && value.startsWith(API_TOKEN_PREFIX);
}

// --- Passwords -----------------------------------------------------------

export async function hashPassword(plain) {
  return bcrypt.hash(String(plain), SALT_ROUNDS);
}

export async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(String(plain), hash);
}

// --- JWTs ----------------------------------------------------------------
// A token either represents a full session (`stage: 'session'`) or an
// intermediate MFA step (`stage: 'mfa-setup' | 'mfa-login'`). The `stage`
// claim is checked by requireStage so a short-lived MFA token can't be used
// as a session token.

export function signToken(payload, { secret = config.auth.jwtSecret, expiresIn } = {}) {
  if (!secret) throw new Error('JWT secret is not configured');
  return jwt.sign(payload, secret, { expiresIn });
}

export function signSessionToken(user, { secret = config.auth.jwtSecret } = {}) {
  return signToken(
    { sub: user.id, email: user.email, role: user.role, stage: 'session' },
    { secret, expiresIn: config.auth.sessionTtl }
  );
}

export function signStageToken(user, stage, { secret = config.auth.jwtSecret } = {}) {
  return signToken(
    { sub: user.id, email: user.email, stage },
    { secret, expiresIn: config.auth.stageTtl }
  );
}

// Verifies signature/expiry and, when `stage` is given, that the token's stage
// matches. Returns the decoded payload or throws.
export function verifyToken(token, { secret = config.auth.jwtSecret, stage } = {}) {
  const payload = jwt.verify(token, secret);
  if (stage && payload.stage !== stage) {
    const err = new Error('Wrong token stage');
    err.code = 'WRONG_STAGE';
    throw err;
  }
  return payload;
}

// --- TOTP MFA ------------------------------------------------------------

export function generateMfaSecret() {
  return authenticator.generateSecret();
}

// otpauth:// URL that authenticator apps turn into a QR code.
export function otpauthUrl(email, secret, issuer = config.auth.mfaIssuer) {
  return authenticator.keyuri(email, issuer, secret);
}

export function verifyTotp(token, secret) {
  if (!token || !secret) return false;
  try {
    return authenticator.verify({ token: String(token).trim(), secret });
  } catch {
    return false;
  }
}

// Renders the otpauth URL as a data: URL PNG for the setup screen.
export async function qrDataUrl(otpauth) {
  return qrcode.toDataURL(otpauth);
}

// --- Middleware ----------------------------------------------------------

export function bearerToken(req) {
  const header = req.headers && req.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (scheme !== 'Bearer' || !value) return null;
  return value.trim();
}

// --- The role a session may act with ---------------------------------------
//
// The session JWT carries the role it was minted with, and `SESSION_TTL` is 30
// days. So changing somebody's role changed nothing the API enforced until they
// signed out and in again, while the UI — which asks /api/auth/me, i.e. the
// database — drew the new role's navigation immediately. Half-applied in the
// harmless direction is a broken screen: a tester promoted to administrator got
// an administrator's menu over a tester's permissions, every one of those
// endpoints answering 403, which is what it looked like when it happened. Applied
// the other way it is worse than broken — an administrator demoted to tester kept
// an administrator's writes for up to a month.
//
// So the claim proves *who* is calling and the database says *what they may do*.
// The personal-access-token path in apiAuth.js already worked this way (it reads
// `u.role` in its lookup); this is the session path catching up, and it is the
// rule changehub follows for its whole viewer.
//
// The decision is split out from the query so it can be tested without a
// database, like everything else in this module.
export function liveAuthDecision(claim, row) {
  if (!row) return { ok: false, status: 401, error: 'Authentication required' };
  // An archived account is not a permission problem to work around — it is not an
  // account. 401 rather than 403 so the browser is signed out instead of showing a
  // screen full of refusals (see apiFetch in the frontend).
  if (row.archived) return { ok: false, status: 401, error: 'Account disabled' };
  return {
    ok: true,
    auth: Object.assign({}, claim, {
      role: row.role,
      // The e-mail can be corrected in the user editor too, and it is what the
      // notification routing excludes the actor by.
      email: row.email || (claim && claim.email) || null,
    }),
  };
}

// The same, against the database. Returns the decision; callers apply it.
export async function resolveLiveAuth(claim) {
  const id = claim && claim.sub;
  if (!id) return { ok: false, status: 401, error: 'Authentication required' };
  const { rows } = await query('SELECT role, email, archived FROM users WHERE id = $1', [id]);
  return liveAuthDecision(claim, rows[0] || null);
}

// Requires a valid token at the given stage (default: a full session token).
// On success attaches the decoded payload to req.auth.
//
// `live: true` re-reads the account's role from the database (see above). Only a
// full session wants it: the MFA stage tokens are one step of signing in, and the
// account they name has not been let in yet.
export function requireStage(stage = 'session', { live = false } = {}) {
  return async function stageGuard(req, res, next) {
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    let claim;
    try {
      claim = verifyToken(token, { stage });
    } catch (err) {
      const msg = err.code === 'WRONG_STAGE' ? 'Wrong token stage' : 'Invalid or expired token';
      return res.status(401).json({ error: msg });
    }
    if (!live) {
      req.auth = claim;
      return next();
    }
    try {
      const decision = await resolveLiveAuth(claim);
      if (!decision.ok) return res.status(decision.status).json({ error: decision.error });
      req.auth = decision.auth;
      return next();
    } catch (err) {
      // A database that cannot answer must not be read as „no permissions": that
      // would silently degrade every guarded route to a 403 instead of an error
      // somebody investigates.
      console.warn('[auth] Live role lookup failed:', err.message);
      return res.status(500).json({ error: 'Authentication error' });
    }
  };
}

// Convenience: guard for a full session, with the role as it is now.
export const requireAuth = requireStage('session', { live: true });
