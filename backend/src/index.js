import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { ipAllowlist } from './ipAllowlist.js';
import { requireAuth } from './auth.js';
import { runMigrations } from './migrate.js';
import health from './routes/health.js';
import authRouter from './routes/auth.js';
import deployments from './routes/deployments.js';
import projects from './routes/projects.js';
import attachments from './routes/attachments.js';
import state from './routes/state.js';

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
// Everything else requires a valid session token.
// Attachments are mounted at /api so both `/api/deployments/:id/attachments`
// and `/api/attachments/:id` resolve here; more specific deployment sub-routes
// are matched before the generic deployments router below.
app.use('/api', requireAuth, attachments);
app.use('/api', requireAuth, state);
app.use('/api/deployments', requireAuth, deployments);
app.use('/api/projects', requireAuth, projects);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown endpoint' }));

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

  // Apply pending database migrations before accepting traffic.
  try {
    await runMigrations();
  } catch (err) {
    console.error('[migrate] Startup migrations failed:', err.message);
    process.exit(1);
  }

  app.listen(config.port, () => {
    console.log(`[rolldesk-backend] port ${config.port} (${config.env})` +
      (config.allowedIps.length ? ` · IP allowlist: ${config.allowedIps.join(', ')}` : ' · IP allowlist: disabled'));
    if (!config.smtp.host) console.warn('[config] SMTP_HOST not set — email sending disabled.');
  });
}

start();
