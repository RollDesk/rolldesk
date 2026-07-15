// Shared application-state endpoints: the append-only audit log and a small set
// of whole-collection settings (user roster, clients, notification recipients).
// Mounted at /api behind requireAuth.
import { Router } from 'express';
import { query } from '../db.js';
import { forbidClient } from '../rbac.js';

const router = Router();

// The change history and shared settings are team-only — client accounts must
// not read or write them.
router.use('/audit', forbidClient);
router.use('/state', forbidClient);

// --- Audit log (append-only) ---------------------------------------------

const AUDIT_COLS = 'ts, actor, role, action, entity, detail, project';

// GET /api/audit — newest first (capped).
router.get('/audit', async (_req, res) => {
  const { rows } = await query(
    `SELECT ${AUDIT_COLS} FROM audit_log ORDER BY created_at DESC, id DESC LIMIT 2000`
  );
  res.json(rows);
});

// POST /api/audit — append a single entry.
router.post('/audit', async (req, res) => {
  const b = req.body || {};
  const { rows } = await query(
    `INSERT INTO audit_log (ts, actor, role, action, entity, detail, project)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING ${AUDIT_COLS}`,
    [b.ts || null, b.actor || null, b.role || null, b.action || null,
     b.entity || null, b.detail || null, b.project || null]
  );
  res.status(201).json(rows[0]);
});

// --- Whole-collection state (key/value JSONB) ----------------------------

const ALLOWED_KEYS = new Set(['roster', 'clients', 'notifications']);

// GET /api/state/:key — returns the stored collection, or null if never saved.
router.get('/state/:key', async (req, res) => {
  if (!ALLOWED_KEYS.has(req.params.key)) return res.status(404).json({ error: 'Unknown state key' });
  const { rows } = await query('SELECT data FROM app_state WHERE key = $1', [req.params.key]);
  res.json(rows.length ? rows[0].data : null);
});

// PUT /api/state/:key — replace the whole collection (last-write-wins).
router.put('/state/:key', async (req, res) => {
  if (!ALLOWED_KEYS.has(req.params.key)) return res.status(404).json({ error: 'Unknown state key' });
  const data = (req.body === undefined || req.body === null) ? {} : req.body;
  const { rows } = await query(
    `INSERT INTO app_state (key, data) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
     RETURNING data`,
    [req.params.key, JSON.stringify(data)]
  );
  res.json(rows[0].data);
});

export default router;
