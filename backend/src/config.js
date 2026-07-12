// Configuration read from environment variables.
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';

// Application version, read from package.json so /health can report it.
const require = createRequire(import.meta.url);
let version = '0.0.0';
try {
  version = require('../package.json').version || version;
} catch {
  /* fall back to default if package.json can't be read */
}

// JWT signing secret. Required in production; in development we fall back to an
// ephemeral random secret (sessions won't survive a backend restart) and warn.
const jwtSecretFromEnv = (process.env.JWT_SECRET || '').trim();
const jwtSecret = jwtSecretFromEnv || (isProd ? '' : crypto.randomBytes(32).toString('hex'));

export const config = {
  env,
  isProd,
  version,
  port: parseInt(process.env.PORT || '3000', 10),
  trustProxy: process.env.TRUST_PROXY === '1',
  allowedIps: (process.env.ALLOWED_IPS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgres://rolldesk:rolldesk@localhost:5432/rolldesk',
  auth: {
    jwtSecret,
    jwtSecretFromEnv: !!jwtSecretFromEnv,
    // Session token lifetime, and the short-lived lifetime for the pending
    // MFA setup/login stage tokens.
    sessionTtl: process.env.SESSION_TTL || '12h',
    stageTtl: process.env.MFA_STAGE_TTL || '10m',
    // Issuer/label shown in the user's authenticator app.
    mfaIssuer: process.env.MFA_ISSUER || 'RollDesk',
  },
  // ClamAV virus scanning for uploaded attachments. When CLAMAV_HOST is set the
  // backend streams each upload to clamd (INSTREAM) before storing it. If a scan
  // can't be completed, failMode decides whether to reject ('reject', default —
  // fail closed) or accept ('allow', fail open) the upload.
  av: {
    host: (process.env.CLAMAV_HOST || '').trim(),
    port: parseInt(process.env.CLAMAV_PORT || '3310', 10),
    timeoutMs: parseInt(process.env.CLAMAV_TIMEOUT_MS || '30000', 10),
    failMode: (process.env.CLAMAV_FAIL_MODE || 'reject').toLowerCase() === 'allow' ? 'allow' : 'reject',
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'RollDesk <no-reply@rolldesk.local>',
  },
};
