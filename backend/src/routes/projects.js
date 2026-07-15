// Project endpoints (with apps stored in the JSONB data column).
import { Router } from 'express';
import { query } from '../db.js';
import { forbidClient, isClient, clientScope } from '../rbac.js';

const router = Router();

function rowToObj(r) {
  return Object.assign(
    { key: r.key, clientName: r.client_name, name: r.name,
      defaultDays: r.default_days, defaultTime: r.default_time,
      clientVisible: r.client_visible },
    r.data
  );
}

// GET /api/projects — client accounts only see the client-visible projects they
// were granted; the team sees everything.
router.get('/', async (req, res) => {
  const { rows } = await query('SELECT * FROM projects ORDER BY client_name, name');
  let list = rows.map(rowToObj);
  if (isClient(req)) {
    const { projects } = await clientScope(req);
    list = list.filter(p => p.clientVisible !== false && projects.includes(p.key));
  }
  res.json(list);
});

router.put('/:key', forbidClient, async (req, res) => {
  const b = req.body || {};
  const data = Object.assign({}, b);
  ['key','clientName','name','defaultDays','defaultTime','clientVisible'].forEach(k=>delete data[k]);
  const { rows } = await query(
    `INSERT INTO projects (key, client_name, name, default_days, default_time, client_visible, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (key) DO UPDATE
       SET client_name=EXCLUDED.client_name, name=EXCLUDED.name,
           default_days=EXCLUDED.default_days, default_time=EXCLUDED.default_time,
           client_visible=EXCLUDED.client_visible, data=EXCLUDED.data
     RETURNING *`,
    [req.params.key, b.clientName || 'Client', b.name || req.params.key,
     b.defaultDays || 5, b.defaultTime || '20:00',
     b.clientVisible !== false, data]
  );
  res.json(rowToObj(rows[0]));
});

// DELETE /api/projects/:key — remove a project and its deployments. Team only.
router.delete('/:key', forbidClient, async (req, res) => {
  const key = req.params.key;
  await query('DELETE FROM deployments WHERE project_key = $1', [key]);
  const { rowCount } = await query('DELETE FROM projects WHERE key = $1', [key]);
  res.json({ deleted: rowCount > 0, key });
});

export default router;
