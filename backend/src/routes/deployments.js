// Deployment endpoints — the full object is stored as JSONB (data).
import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

// Returns the stored deployment object (JSONB) with the id attached.
function rowToObj(r) {
  return Object.assign({ id: r.id }, r.data);
}

// GET /api/deployments — list of full objects, with filters.
router.get('/', async (req, res) => {
  const { project, env, status } = req.query;
  const clauses = [], params = [];
  if (project) { params.push(project); clauses.push(`project_key = $${params.length}`); }
  if (env)     { params.push(env);     clauses.push(`env = $${params.length}`); }
  if (status)  { params.push(status);  clauses.push(`status = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await query(`SELECT * FROM deployments ${where} ORDER BY created_at ASC`, params);
  res.json(rows.map(rowToObj));
});

router.get('/:id', async (req, res) => {
  const { rows } = await query('SELECT * FROM deployments WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rowToObj(rows[0]));
});

// Upsert of the full deployment object (PUT by id) — used by the frontend.
async function upsert(id, body) {
  const projectKey = body.projectKey || body.project_key || 'unknown';
  const env = body.env || null;
  const status = body.status || (body.counts && body.counts.scheduled === 0 ? 'installed' : 'scheduled');
  const internal = !!body.internal;
  const data = Object.assign({}, body);
  delete data.id; // id is kept in its own column
  const { rows } = await query(
    `INSERT INTO deployments (id, project_key, env, status, internal, data)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (id) DO UPDATE
       SET project_key = EXCLUDED.project_key,
           env = EXCLUDED.env,
           status = EXCLUDED.status,
           internal = EXCLUDED.internal,
           data = EXCLUDED.data,
           updated_at = now()
     RETURNING *`,
    [id, projectKey, env, status, internal, data]
  );
  return rowToObj(rows[0]);
}

// PUT /api/deployments/:id — create or update (the frontend uses this to save).
router.put('/:id', async (req, res) => {
  const body = req.body || {};
  if (!body.projectKey && !body.project_key) {
    return res.status(422).json({ error: 'Required field: projectKey' });
  }
  const obj = await upsert(req.params.id, body);
  res.json(obj);
});

// POST /api/deployments — create (id from the body or generated).
router.post('/', async (req, res) => {
  const body = req.body || {};
  const id = body.id || ('DEP-' + new Date().getFullYear() + '-' + Date.now().toString().slice(-4));
  const obj = await upsert(id, body);
  res.status(201).json(obj);
});

// DELETE /api/deployments/:id
router.delete('/:id', async (req, res) => {
  await query('DELETE FROM deployments WHERE id = $1', [req.params.id]);
  res.json({ deleted: true, id: req.params.id });
});

export default router;
