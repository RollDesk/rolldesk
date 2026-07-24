import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { ipAllowlist } from './ipAllowlist.js';
import { requireAuth } from './auth.js';
import { requireApiAuth } from './apiAuth.js';
import { runMigrations, verifyMigrations } from './migrate.js';
import health from './routes/health.js';
import authRouter from './routes/auth.js';
import deployments from './routes/deployments.js';
import projects from './routes/projects.js';
import attachments from './routes/attachments.js';
import state from './routes/state.js';
import notifications from './routes/notifications.js';
import tokens from './routes/tokens.js';
import users from './routes/users.js';
import sso from './routes/sso.js';
import teams from './routes/teams.js';

const app = express();
if (config.trustProxy) app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

// /health is not IP-filtered (useful for monitoring/orchestration).
app.use('/health', health);

// IP restriction for the whole API (in addition to nginx).
app.use('/api', ipAllowlist);
// Auth endpoints are open (they issue the tokens); each self-guards.
app.use('/api/auth', authRouter);
// Token management requires an interactive session (a JWT) — never an API
// token — so a token cannot mint or revoke other tokens. Mounted before the
// data routes so it isn't shadowed by the generic /api guard.
app.use('/api/tokens', requireAuth, tokens);
// User management requires an interactive session (admin-only, enforced inside).
app.use('/api/users', requireAuth, users);
// SSO provider configuration (admin-only, enforced inside). Requires an
// interactive session — never an API token.
app.use('/api/sso', requireAuth, sso);
// The data API accepts either a session JWT or a personal access token, so
// scripts/CI can call it with `Authorization: Bearer rd_live_…`.
// Attachments are mounted at /api so both `/api/deployments/:id/attachments`
// and `/api/attachments/:id` resolve here; more specific deployment sub-routes
// are matched before the generic deployments router below.
app.use('/api', requireApiAuth, attachments);
app.use('/api', requireApiAuth, state);
app.use('/api/notifications', requireApiAuth, notifications);
app.use('/api/teams', requireApiAuth, teams);
app.use('/api/deployments', requireApiAuth, deployments);
app.use('/api/projects', requireApiAuth, projects);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown endpoint' }));

// Central error handler. Express 5 forwards rejected async handlers here, so a
// failing DB query (or any thrown error) is logged with its route instead of
// vanishing into a bare 500. Keeps the client response clean (no stack leak).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error(`[error] ${req.method} ${req.originalUrl} →`, err && err.stack ? err.stack : err);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

async function start() {
  // A signing secret is mandatory in production; without it sessions can't be
  // trusted, so refuse to start rather than fall back to an ephemeral secret.
  if (config.isProd && !config.auth.jwtSecret) {
    console.error('[config] JWT_SECRET is required in production. Refusing to start.');
    process.exit(1);
  }
  if (!config.auth.jwtSecretFromEnv) {
    console.warn('[config] JWT_SECRET not set — using an ephemeral secret; sessions reset on restart.');
  }

  // Ensure the database schema is current before accepting traffic. In 'auto'
  // mode we apply any pending migrations; in 'verify' mode we only check and
  // refuse to start when migrations are pending. Either way a failure aborts
  // startup so the app never serves traffic against an unmigrated database.
  try {
    if (config.migrateMode === 'verify') {
      await verifyMigrations();
    } else {
      await runMigrations();
    }
  } catch (err) {
    console.error(`[migrate] Startup (${config.migrateMode}) failed:`, err.message);
    process.exit(1);
  }

  app.listen(config.port, () => {
    console.log(`[rolldesk-backend] port ${config.port} (${config.env})` +
      (config.allowedIps.length ? ` · IP allowlist: ${config.allowedIps.join(', ')}` : ' · IP allowlist: disabled'));
    // Log the effective SMTP configuration the process actually sees, so a
    // missing/blank value (e.g. a container not recreated after editing .env)
    // is obvious from the logs rather than silently disabling e-mail.
    if (config.smtp.host) {
      console.log(
        `[config] SMTP: ${config.smtp.host}:${config.smtp.port} ` +
        `secure=${config.smtp.secure} auth=${config.smtp.user ? 'on' : 'off'} from="${config.smtp.from}"`
      );
    } else {
      console.warn('[config] SMTP_HOST not set — email sending disabled.');
    }
  });
}

start();
