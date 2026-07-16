// Deployment endpoints — the full object is stored as JSONB (data).
import { Router } from 'express';
import { query } from '../db.js';
import { forbidClient, isClient, isInstaller, clientScope, userScope } from '../rbac.js';

const router = Router();

// Returns the stored deployment object (JSONB) with the id attached.
function rowToObj(r) {
  return Object.assign({ id: r.id }, r.data);
}

// GET /api/deployments — list of full objects, with filters.
// Client accounts only ever see non-internal deployments of the projects they
// belong to (never internal ones, never other projects/clients).
router.get('/', async (req, res) => {
  const { project, env, status } = req.query;
  const clauses = [], params = [];
  if (project) { params.push(project); clauses.push(`project_key = $${params.length}`); }
  if (env)     { params.push(env);     clauses.push(`env = $${params.length}`); }
  if (status)  { params.push(status);  clauses.push(`status = $${params.length}`); }

  if (isClient(req)) {
    const { projects } = await clientScope(req);
    if (!projects.length) return res.json([]); // no project access → nothing to show
    params.push(projects);
    clauses.push(`project_key = ANY($${params.length}::text[])`);
    clauses.push('internal = false');
  } else if (isInstaller(req)) {
    // A Deployer only gets deployments of the projects they were granted.
    const { projects } = await userScope(req);
    if (!projects.length) return res.json([]);
    params.push(projects);
    clauses.push(`project_key = ANY($${params.length}::text[])`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await query(`SELECT * FROM deployments ${where} ORDER BY created_at ASC`, params);
  res.json(rows.map(rowToObj));
});

router.get('/:id', async (req, res) => {
  const { rows } = await query('SELECT * FROM deployments WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const row = rows[0];
  // A client may only fetch a non-internal deployment of one of their projects.
  if (isClient(req)) {
    const { projects } = await clientScope(req);
    if (row.internal || !projects.includes(row.project_key)) {
      return res.status(404).json({ error: 'Not found' });
    }
  } else if (isInstaller(req)) {
    const { projects } = await userScope(req);
    if (!projects.includes(row.project_key)) {
      return res.status(404).json({ error: 'Not found' });
    }
  }
  res.json(rowToObj(row));
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

// POST /api/deployments/:id/decision — record a client's schedule decision.
// This is deliberately NOT behind forbidClient: approving/commenting on a
// schedule is the client's own action. It merges the decision into the stored
// deployment and appends an audit-log entry server-side (clients can't write the
// audit log directly), so the change history and timeline are consistent for
// everyone after a reload.
router.post('/:id/decision', async (req, res) => {
  const { rows } = await query('SELECT * FROM deployments WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const row = rows[0];
  // A client may only act on a non-internal deployment of one of their projects.
  if (isClient(req)) {
    const { projects } = await clientScope(req);
    if (row.internal || !projects.includes(row.project_key)) {
      return res.status(404).json({ error: 'Not found' });
    }
  }

  const b = req.body || {};
  const decision = String(b.decision || '').trim();
  if (!['approved', 'commented', 'reschedule'].includes(decision)) {
    return res.status(422).json({ error: 'Invalid decision (expected approved | commented | reschedule)' });
  }
  const by = (String(b.by || '').trim() || null);
  const commentText = String(b.commentText || '').slice(0, 2000);

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stampDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const stampTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

  const data = Object.assign({}, row.data);
  data.clientApproval = decision === 'approved' ? 'approved' : 'commented';
  if (by) data.clientApprovalBy = by;
  data.clientApprovalDate = stampDate;
  data.clientApprovalTime = stampTime;
  if (commentText) data.clientComment = commentText;
  if (commentText) {
    data.comments = Array.isArray(data.comments) ? data.comments : [];
    data.comments.push({
      date: stampDate, time: stampTime, author: by || null, type: 'system',
      icon: decision === 'reschedule' ? '📅' : (decision === 'approved' ? '✅' : '💬'),
      text: commentText,
    });
  }

  await query(
    `UPDATE deployments SET data = $2, updated_at = now() WHERE id = $1`,
    [req.params.id, data]
  );

  // Append the audit entry server-side. The UI passes the localizable key/params
  // so the change history renders it in the reader's language.
  const detail = String(b.auditDetail || '').slice(0, 1000) || null;
  const auditKey = b.auditKey ? String(b.auditKey).slice(0, 120) : null;
  const auditParams = b.auditParams && typeof b.auditParams === 'object' ? b.auditParams : null;
  const project = String(b.projectLabel || row.project_key || '').slice(0, 300) || null;
  const actor = by || (req.auth && req.auth.email) || 'Client';
  const role = (req.auth && req.auth.role) || 'client';
  try {
    await query(
      `INSERT INTO audit_log (ts, actor, role, action, entity, detail, project, detail_key, detail_params)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [`${stampDate} ${stampTime}`, actor, role, 'changed', 'Deployment', detail, project,
       auditKey, auditParams ? JSON.stringify(auditParams) : null]
    );
  } catch (err) {
    // Non-fatal: the decision itself is saved even if the audit insert fails.
    console.warn('[decision] audit insert failed:', err.message);
  }

  res.json(rowToObj({ id: row.id, data }));
});

// PUT /api/deployments/:id — create or update (the frontend uses this to save).
router.put('/:id', forbidClient, async (req, res) => {
  const body = req.body || {};
  if (!body.projectKey && !body.project_key) {
    return res.status(422).json({ error: 'Required field: projectKey' });
  }
  const obj = await upsert(req.params.id, body);
  res.json(obj);
});

// POST /api/deployments — create (id from the body or generated).
router.post('/', forbidClient, async (req, res) => {
  const body = req.body || {};
  const id = body.id || ('DEP-' + new Date().getFullYear() + '-' + Date.now().toString().slice(-4));
  const obj = await upsert(id, body);
  res.status(201).json(obj);
});

// DELETE /api/deployments/:id
router.delete('/:id', forbidClient, async (req, res) => {
  await query('DELETE FROM deployments WHERE id = $1', [req.params.id]);
  res.json({ deleted: true, id: req.params.id });
});

export default router;
