import { Router } from 'express';
import { ping } from '../db.js';
import { config } from '../config.js';
import { getMigrationStatus } from '../migrate.js';

const router = Router();

// Liveness/readiness probe. Confirms the process is up, that the backend can
// reach the database, and that the schema is fully migrated. Returns 200 when
// everything is healthy, 503 when the database check fails so
// orchestrators/monitoring can react.
router.get('/', async (_req, res) => {
  const startedAt = Date.now();
  const body = {
    status: 'ok',
    version: config.version,
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    checks: { database: { status: 'up', latencyMs: 0 } },
  };

  try {
    await ping();
    body.checks.database.latencyMs = Date.now() - startedAt;
    // Report migration status so monitoring can catch a DB that drifted behind
    // the code (e.g. a partial deploy). Pending migrations mark health degraded.
    try {
      const mig = await getMigrationStatus();
      body.checks.migrations = {
        status: mig.upToDate ? 'up' : 'pending',
        mode: config.migrateMode,
        applied: mig.applied.length,
        pending: mig.pending,
      };
      if (!mig.upToDate) body.status = 'degraded';
    } catch (err) {
      body.checks.migrations = { status: 'unknown', error: err.message };
    }
    res.json(body);
  } catch (err) {
    body.status = 'degraded';
    body.checks.database = {
      status: 'down',
      latencyMs: Date.now() - startedAt,
      error: err.message,
    };
    res.status(503).json(body);
  }
});

export default router;
