// Configuration read from environment variables.
export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  trustProxy: process.env.TRUST_PROXY === '1',
  allowedIps: (process.env.ALLOWED_IPS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgres://rolldesk:rolldesk@localhost:5432/rolldesk',
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'RollDesk <no-reply@rolldesk.local>',
  },
};
