// Deployment endpoints — the full object is stored as JSONB (data).
import { Router } from 'express';
import { query } from '../db.js';
import {
  forbidClient, isClient, isInstaller, clientScope, userScope,
  projectSharesAdminInfo, stripAdminInfoFromDeployment,
} from '../rbac.js';
import {
  mergeDeploymentPatch, summarizeChanges, deploymentColumns, completeBatchRollout,
} from '../deploymentPatch.js';
import { formatStamp } from '../stamp.js';
import { config } from '../config.js';

const router = Router();

// Wall-clock stamp in the `YYYY-MM-DD` / `HH:MM` shape the stored timeline and
// the audit log use (both are human-readable strings captured at write time),
// in the configured zone — see stamp.js for why the zone is explicit.
function nowStamp() {
  return formatStamp(new Date(), config.timeZone);
}

// Returns the stored deployment object (JSONB) with the id attached.
function rowToObj(r) {
  return Object.assign({ id: r.id }, r.data);
}

// For client accounts, drop deployer/admin notes unless the project opts in.
async function shapeForCaller(req, obj) {
  if (!isClient(req) || !obj) return obj;
  if (await projectSharesAdminInfo(obj.projectKey || obj.project_key)) return obj;
  return stripAdminInfoFromDeployment(obj);
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
  const list = rows.map(rowToObj);
  if (!isClient(req)) return res.json(list);
  // Cache the per-project share flag so a long list does not re-query once per row.
  const shareCache = new Map();
  const out = [];
  for (const obj of list) {
    const pk = obj.projectKey || obj.project_key;
    let share = shareCache.get(pk);
    if (share === undefined) {
      share = await projectSharesAdminInfo(pk);
      shareCache.set(pk, share);
    }
    out.push(share ? obj : stripAdminInfoFromDeployment(obj));
  }
  res.json(out);
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
  res.json(await shapeForCaller(req, rowToObj(row)));
});

// Upsert of the full deployment object (PUT by id) — used by the frontend.
async function upsert(id, body) {
  const { projectKey, env, status, internal } = deploymentColumns(body);
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

  const { date: stampDate, time: stampTime } = nowStamp();

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

  res.json(await shapeForCaller(req, rowToObj({ id: row.id, data })));
});

// PATCH /api/deployments/:id — change individual fields, leaving the rest of
// the stored object alone.
//
// PUT replaces the whole object, which suits the UI (it always holds the full
// deployment in memory) but makes automation awkward: a script that only wants
// to flip the status has to GET, mutate and PUT the entire record back, and any
// serialization mistake on the way silently truncates the schedule, comments or
// counts. PATCH is the endpoint for `Authorization: Bearer rd_live_…` callers.
//
// The merge is shallow (see deploymentPatch.js) and, unlike PUT, this route
// will not create a deployment — patching something that does not exist is a
// mistake worth reporting, not an upsert. Installers are limited to the
// projects they were granted, matching what they can read.
router.patch('/:id', forbidClient, async (req, res) => {
  const { rows } = await query('SELECT * FROM deployments WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const row = rows[0];
  if (isInstaller(req)) {
    const { projects } = await userScope(req);
    if (!projects.includes(row.project_key)) {
      return res.status(404).json({ error: 'Not found' });
    }
  }

  const merged = mergeDeploymentPatch(row.data, req.body, req.params.id);
  if (!merged.ok) return res.status(422).json({ error: merged.error });

  // Marking a multi-target rollout installed has to close its pending queue, or
  // the record keeps rendering as in-progress (see completeBatchRollout).
  const changes = merged.changes.slice();
  if (req.body.status === 'installed' && merged.data.mode === 'batch') {
    changes.push(...completeBatchRollout(merged.data));
  }

  // A patch that changes nothing is a success, not an error — an idempotent
  // retry of "mark it installed" must not fail the second time. Return the
  // stored object without touching updated_at or writing a history entry.
  if (!changes.length) {
    return res.json(rowToObj(row));
  }

  const summary = summarizeChanges(changes);
  const stamp = nowStamp();
  const actor = (req.auth && req.auth.email) || 'API';
  const data = merged.data;

  // Record the change on the deployment's own timeline, the way the UI does
  // when someone edits a row, so the two are indistinguishable after a reload.
  data.comments = Array.isArray(data.comments) ? data.comments : [];
  data.comments.push({
    date: stamp.date, time: stamp.time, author: actor, type: 'system', icon: '🔄',
    text: `Deployment changed via the API (${summary})`,
  });

  // Derive the filterable columns from the merged object, but fall back to the
  // stored column rather than the generic default: a deployment created through
  // POST with only `counts` has its status in the column and not in `data`, and
  // a patch of an unrelated field must not silently reset it.
  const cols = deploymentColumns(Object.assign(
    {},
    data,
    { projectKey: row.project_key },
    'status' in data ? {} : { status: row.status },
    'env' in data ? {} : { env: row.env },
    'internal' in data ? {} : { internal: row.internal }
  ));
  const { rows: updated } = await query(
    `UPDATE deployments
        SET env = $2, status = $3, internal = $4, data = $5, updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [req.params.id, cols.env, cols.status, cols.internal, data]
  );

  // Append the audit entry server-side — an API caller has no UI to do it for
  // it, and a change with no trace in the history is the thing the audit log
  // exists to prevent. `summary` is English free text, like the summaries the
  // UI passes for its own edits.
  try {
    await query(
      `INSERT INTO audit_log (ts, actor, role, action, entity, detail, project, detail_key, detail_params)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      // An empty role rather than null: the history renders the stored value
      // verbatim when it is not one of the known roles.
      [`${stamp.date} ${stamp.time}`, actor, (req.auth && req.auth.role) || '',
       'changed', 'Deployment',
       `Changed deployment ${row.id} via the API — ${summary}`,
       row.project_key || null,
       'aud.d.depPatchedApi',
       JSON.stringify({ id: row.id, summary })]
    );
  } catch (err) {
    // Non-fatal: the change itself is saved even if the audit insert fails.
    console.warn('[patch] audit insert failed:', err.message);
  }

  res.json(rowToObj(updated[0]));
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
