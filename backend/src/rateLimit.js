// In-memory rate limiters for the authentication endpoints. State lives in the
// backend process (no external store like Redis), which is enough for a single
// instance: it slows down password/TOTP guessing without adding infrastructure.
//
// Both limiters use `skipSuccessfulRequests` so only failed attempts (4xx/5xx)
// count toward the limit — legitimate users are never locked out by succeeding.
import { rateLimit } from 'express-rate-limit';

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function make(max, message) {
  return rateLimit({
    windowMs: WINDOW_MS,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: message },
    // The backend always runs behind nginx (`trust proxy` is enabled so the
    // real client IP comes from X-Forwarded-For). Silence the library's
    // permissive-trust-proxy check, which would otherwise warn on every start.
    validate: { trustProxy: false },
  });
}

// Password entry: login + first-run setup. Caps failed attempts per IP.
export const credentialLimiter = make(
  10,
  'Too many failed attempts. Please try again in a few minutes.'
);

// TOTP code entry: MFA verify/login/reconfigure. Caps failed codes per IP.
export const mfaCodeLimiter = make(
  10,
  'Too many invalid codes. Please try again in a few minutes.'
);
