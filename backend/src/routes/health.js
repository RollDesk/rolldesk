import { Router } from 'express';
import { ping } from '../db.js';
import { config } from '../config.js';

const router = Router();

// Liveness/readiness probe. Confirms the process is up and that the backend can
// reach the database. Returns 200 when everything is healthy, 503 when the
// database check fails so orchestrators/monitoring can react.
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
