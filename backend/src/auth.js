// Authentication helpers: password hashing, JWT signing/verification and TOTP
// MFA. The functions here are pure (no DB, no Express) so they can be unit
// tested in isolation; the Express middleware at the bottom wires them in.
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { authenticator } from 'otplib';
import qrcode from 'qrcode';
import { config } from './config.js';

const SALT_ROUNDS = 10;

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

function bearerToken(req) {
  const header = req.headers && req.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (scheme !== 'Bearer' || !value) return null;
  return value.trim();
}

// Requires a valid token at the given stage (default: a full session token).
// On success attaches the decoded payload to req.auth.
export function requireStage(stage = 'session') {
  return function stageGuard(req, res, next) {
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    try {
      req.auth = verifyToken(token, { stage });
      return next();
    } catch (err) {
      const msg = err.code === 'WRONG_STAGE' ? 'Wrong token stage' : 'Invalid or expired token';
      return res.status(401).json({ error: msg });
    }
  };
}

// Convenience: guard for a full session.
export const requireAuth = requireStage('session');
