import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { ipAllowlist } from './ipAllowlist.js';
import { runMigrations } from './migrate.js';
import health from './routes/health.js';
import deployments from './routes/deployments.js';
import projects from './routes/projects.js';

const app = express();
if (config.trustProxy) app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

// /health is not IP-filtered (useful for monitoring/orchestration).
app.use('/health', health);

// IP restriction for the whole API (in addition to nginx).
app.use('/api', ipAllowlist);
app.use('/api/deployments', deployments);
app.use('/api/projects', projects);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown endpoint' }));

async function start() {
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
