// Project endpoints (with apps stored in the JSONB data column).
import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

function rowToObj(r) {
  return Object.assign(
    { key: r.key, clientName: r.client_name, name: r.name,
      defaultDays: r.default_days, defaultTime: r.default_time,
      clientVisible: r.client_visible },
    r.data
  );
}

router.get('/', async (_req, res) => {
  const { rows } = await query('SELECT * FROM projects ORDER BY client_name, name');
  res.json(rows.map(rowToObj));
});

router.put('/:key', async (req, res) => {
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

export default router;
