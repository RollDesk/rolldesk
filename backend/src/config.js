// Configuration read from environment variables.
import crypto from 'node:crypto';

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';

// JWT signing secret. Required in production; in development we fall back to an
// ephemeral random secret (sessions won't survive a backend restart) and warn.
const jwtSecretFromEnv = (process.env.JWT_SECRET || '').trim();
const jwtSecret = jwtSecretFromEnv || (isProd ? '' : crypto.randomBytes(32).toString('hex'));

export const config = {
  env,
  isProd,
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
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'RollDesk <no-reply@rolldesk.local>',
  },
};
