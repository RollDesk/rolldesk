// Release-package endpoints. Mounted at /api/packages.
//
// The test team assembles a package (application versions + the issues they
// fix); a release manager picks one when planning a deployment. Reads are scoped
// the way deployments are — testers and installers see the projects they were
// granted, clients only the non-internal projects they belong to, because the
// issue list is shown to them in the portal.
import { Router } from 'express';
import { query } from '../db.js';
import {
  isClient, isScopedRole, clientScope, userScope, requirePackageRole,
  requirePackageApprovalRole,
} from '../rbac.js';
import {
  normalizePackage, packageRowToObj, nextPackageId, stripAdminInfoFromPackage,
  makeApproval, normalizeApproval, approvalSurvivesEdit,
} from '../releasePackage.js';
import {
  lookupWorkItem, searchWorkItems, projectTrackerSettings, trackerStatus,
} from '../trackerService.js';
import { projectSharesAdminInfo } from '../rbac.js';

const router = Router();

// The files uploaded onto the given packages, keyed by package id. Fetched in one
// query for the whole list — a package list is read on every page load, and a
// query per row is what makes that slow.
async function filesByPackage(ids) {
  const map = new Map();
  if (!ids.length) return map;
  const { rows } = await query(
    `SELECT id, package_id, filename, kind, mime, byte_size, uploaded_at
       FROM attachments WHERE package_id = ANY($1::text[])
      ORDER BY uploaded_at ASC`,
    [ids]
  );
  rows.forEach((r) => {
    const list = map.get(r.package_id) || [];
    list.push({
      id: String(r.id),
      filename: r.filename,
      kind: r.kind || 'changelog',
      mime: r.mime,
      size: Number(r.byte_size),
      uploadedAt: r.uploaded_at,
    });
    map.set(r.package_id, list);
  });
  return map;
}

// Display names for the addresses a package records — who assembled it, who handed
// it over, who cleared it. The addresses are what is stored (they are the stable
// identity, and a renamed person must not rewrite history), but an address is not
// what anybody wants to read on a timeline. Resolved in one query for the whole
// list rather than per row.
async function displayNames(emails) {
  const want = [...new Set(emails.filter(Boolean).map((e) => String(e).trim().toLowerCase()))];
  const map = new Map();
  if (!want.length) return map;
  const { rows } = await query(
    'SELECT email, name FROM users WHERE lower(email) = ANY($1::text[])', [want]
  );
  rows.forEach((r) => { if (r.name) map.set(String(r.email).toLowerCase(), r.name); });
  return map;
}

// Rows → API objects, with each package's files attached and the deployer-facing
// half removed for a client account whose project does not share admin info.
async function shapePackages(req, rows) {
  const files = await filesByPackage(rows.map((r) => r.id));
  const objs = rows.map((r) => Object.assign(packageRowToObj(r), { files: files.get(r.id) || [] }));
  // Who did what, by name. Not for a client account: our own team's addresses and
  // names are internal plumbing to them, and the portal already says only what a
  // client is meant to read.
  if (!isClient(req)) {
    const names = await displayNames(objs.flatMap((o) => [
      o.createdBy, o.readyBy, o.approval && o.approval.by,
    ]));
    const name = (email) => (email ? names.get(String(email).trim().toLowerCase()) : '') || undefined;
    objs.forEach((o) => {
      o.createdByName = name(o.createdBy);
      o.readyByName = name(o.readyBy);
      if (o.approval && o.approval.by) o.approval.byName = name(o.approval.by);
    });
  }
  if (!isClient(req)) return objs;
  // One flag lookup per project, not per package.
  const shareCache = new Map();
  const out = [];
  for (const obj of objs) {
    let share = shareCache.get(obj.projectKey);
    if (share === undefined) {
      share = await projectSharesAdminInfo(obj.projectKey);
      shareCache.set(obj.projectKey, share);
    }
    out.push(share ? obj : stripAdminInfoFromPackage(obj));
  }
  return out;
}

// Project scope for a read. Returns null when the caller sees everything, or an
// array of project keys (possibly empty — meaning "nothing").
async function readScope(req) {
  if (isClient(req)) return (await clientScope(req)).projects;
  // Every scoped role, so the project manager added for the approval gate is
  // narrowed to their own projects without this list having to be remembered again.
  if (isScopedRole(req)) return (await userScope(req)).projects;
  return null; // admin / rm
}

// GET /api/packages/lookup/:project/:workItemId — read one work item from the
// project's configured work tracker and return the ids that belong on an issue
// entry: the service-desk ticket the work item points at, and the office that
// reported that ticket.
//
// Declared before /:id so "lookup" is not read as a package id. It is a read
// against an external system on behalf of the caller, so it carries the same
// role and project scope as writing the package the answer ends up on.
//
// A failure is a 200 with ok:false, not an error status: the tester types the
// ticket id by hand in that case, which is exactly what they did before this
// endpoint existed. Turning an unconfigured project into a 4xx would make the
// UI treat a normal setup as a fault.
router.get('/lookup/:project/:workItemId', requirePackageRole, async (req, res) => {
  const projectKey = req.params.project;
  if (await forbiddenProject(req, projectKey)) {
    return res.status(403).json({ error: 'Not permitted for this project' });
  }
  const result = await lookupWorkItem(projectKey, req.params.workItemId);
  res.json(result);
});

// GET /api/packages/search/:project?q=<fragment> — suggestions while a work item
// id is being typed, the way the tracker's own search box answers. Same role and
// project scope as the lookup above, and the same contract: a failure is a 200 with
// ok:false and an empty list, because typing the id by hand has to keep working
// whatever the search service says.
//
// Declared before /:id so "search" is not read as a package id.
router.get('/search/:project', requirePackageRole, async (req, res) => {
  if (await forbiddenProject(req, req.params.project)) {
    return res.status(403).json({ error: 'Not permitted for this project' });
  }
  res.json(await searchWorkItems(req.params.project, req.query.q));
});

// GET /api/packages/tracker-status/:project — whether the lookup can run at all,
// so the editor can say "not configured" instead of silently doing nothing. Never
// returns the PAT or API key.
router.get('/tracker-status/:project', requirePackageRole, async (req, res) => {
  if (await forbiddenProject(req, req.params.project)) {
    return res.status(403).json({ error: 'Not permitted for this project' });
  }
  res.json(trackerStatus(await projectTrackerSettings(req.params.project)));
});

// GET /api/packages — optionally filtered by project or status.
router.get('/', async (req, res) => {
  const { project, status } = req.query;
  const clauses = [], params = [];
  if (project) { params.push(project); clauses.push(`project_key = $${params.length}`); }
  if (status) { params.push(status); clauses.push(`status = $${params.length}`); }

  const scope = await readScope(req);
  if (scope) {
    if (!scope.length) return res.json([]);
    params.push(scope);
    clauses.push(`project_key = ANY($${params.length}::text[])`);
  }
  // A client is shown what a rollout fixes, not what the test team is still
  // assembling: only packages already handed over are visible to them.
  if (isClient(req)) clauses.push(`status = 'ready'`);

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT * FROM release_packages ${where} ORDER BY created_at DESC`,
    params
  );
  res.json(await shapePackages(req, rows));
});

router.get('/:id', async (req, res) => {
  const { rows } = await query('SELECT * FROM release_packages WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const row = rows[0];
  const scope = await readScope(req);
  // 404 rather than 403: whether a package exists in another project is itself
  // information the caller is not entitled to.
  if (scope && !scope.includes(row.project_key)) return res.status(404).json({ error: 'Not found' });
  if (isClient(req) && row.status !== 'ready') return res.status(404).json({ error: 'Not found' });
  res.json((await shapePackages(req, [row]))[0]);
});

// A tester (and a project manager, who approves) may only act within the projects
// they were granted; admins and release managers are unscoped, like everywhere else.
async function forbiddenProject(req, projectKey) {
  if (!isScopedRole(req)) return false;
  const { projects } = await userScope(req);
  return !projects.includes(projectKey);
}

async function upsert(id, shaped) {
  const { rows } = await query(
    `INSERT INTO release_packages (id, project_key, name, status, created_by, data)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (id) DO UPDATE
       SET project_key = EXCLUDED.project_key,
           name = EXCLUDED.name,
           status = EXCLUDED.status,
           data = EXCLUDED.data,
           updated_at = now()
     RETURNING *`,
    // created_by is deliberately not updated: it records who assembled the
    // package, not who last touched it.
    [id, shaped.projectKey, shaped.name, shaped.status, shaped.createdBy, shaped.data]
  );
  // Files come back on a write too: the editor replaces its copy of the package
  // with what was saved, and a response without them would blank the file list
  // until the next full reload.
  const files = await filesByPackage([id]);
  return Object.assign(packageRowToObj(rows[0]), { files: files.get(id) || [] });
}

// POST /api/packages — create. The id is generated unless one is supplied.
router.post('/', requirePackageRole, async (req, res) => {
  const actor = (req.auth && req.auth.email) || null;
  const shaped = normalizePackage(req.body, { createdBy: actor });
  if (!shaped.ok) return res.status(422).json({ error: shaped.error });
  if (await forbiddenProject(req, shaped.data.projectKey)) {
    return res.status(403).json({ error: 'Not permitted for this project' });
  }
  // When the test team handed the release over. Recorded here rather than derived,
  // because `updated_at` moves on every later edit — and the timeline in the
  // packages view is asked exactly this: „when did this go over the wall".
  if (shaped.data.status === 'ready') {
    shaped.data.data.readyAt = new Date().toISOString();
    shaped.data.data.readyBy = actor || undefined;
  }
  let id = shaped.data.id;
  if (!id) {
    const { rows } = await query('SELECT id FROM release_packages');
    id = nextPackageId(rows.map((r) => r.id), new Date().getFullYear());
  }
  res.status(201).json(await upsert(id, shaped.data));
});

// PUT /api/packages/:id — create or replace. A package stays editable after a
// deployment has used it: a late-arriving fix belongs on the list the client
// reads, so the package is the living record of what the release contains.
router.put('/:id', requirePackageRole, async (req, res) => {
  const { rows: existing } = await query(
    'SELECT project_key, created_by, status, data FROM release_packages WHERE id = $1',
    [req.params.id]
  );
  const prev = existing[0];
  const actor = (req.auth && req.auth.email) || null;
  const shaped = normalizePackage(req.body, {
    id: req.params.id,
    createdBy: (prev && prev.created_by) || actor,
  });
  if (!shaped.ok) return res.status(422).json({ error: shaped.error });
  // Both the project it is moving to and, for an existing package, the one it is
  // moving out of have to be within the tester's scope.
  if (await forbiddenProject(req, shaped.data.projectKey)
      || (prev && await forbiddenProject(req, prev.project_key))) {
    return res.status(403).json({ error: 'Not permitted for this project' });
  }
  // The approval is never taken from the request body — it is written by the two
  // routes below and by nothing else, so a package cannot approve itself through
  // an ordinary save. It is carried over from the stored package when the edit did
  // not change what would be installed, and dropped when it did: the project
  // manager cleared a specific build (see approvalSurvivesEdit). Since `data` is
  // replaced wholesale, doing nothing here would silently clear every approval on
  // the next typo fix.
  const prevData = (prev && prev.data && typeof prev.data === 'object') ? prev.data : {};
  // The handover stamp: set on the transition into 'ready', kept as it was on every
  // later edit (`data` is replaced wholesale, so not carrying it would move the
  // handover date every time a typo was fixed), and dropped when the package goes
  // back to being a draft — it has not been handed over any more.
  if (shaped.data.status === 'ready') {
    if (prev && prev.status === 'ready' && prevData.readyAt) {
      shaped.data.data.readyAt = prevData.readyAt;
      shaped.data.data.readyBy = prevData.readyBy || undefined;
    } else {
      shaped.data.data.readyAt = new Date().toISOString();
      shaped.data.data.readyBy = actor || undefined;
    }
  }
  const storedApproval = normalizeApproval(prevData.approval);
  const keep = storedApproval
    && prev.status === shaped.data.status
    && approvalSurvivesEdit(prevData, shaped.data.data);
  if (keep) shaped.data.data.approval = storedApproval;
  const saved = await upsert(req.params.id, shaped.data);
  // Said out loud in the response so the editor can tell the person that the
  // release has to be cleared again, rather than leaving them to notice it in the
  // schedule form a day later.
  if (storedApproval && !keep) saved.approvalCleared = true;
  res.json(saved);
});

// POST /api/packages/:id/approve — the project manager clears a release for
// deployment, with an optional comment („after the maintenance window", „skip
// office X"). Until this exists on a package the schedule form will not plan from
// it: the test team says the build is finished, this says it may go out.
//
// Its own route rather than a field on PUT, because it is a different decision by
// a different person under a different guard — and because a body that could carry
// `approval` would let whoever edits a package approve it.
router.post('/:id/approve', requirePackageApprovalRole, async (req, res) => {
  const { rows } = await query(
    'SELECT project_key, status, data FROM release_packages WHERE id = $1',
    [req.params.id]
  );
  const row = rows[0];
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (await forbiddenProject(req, row.project_key)) {
    return res.status(403).json({ error: 'Not permitted for this project' });
  }
  // A draft has not been handed over yet: approving one would clear a build the
  // test team is still changing, and the approval would be dropped by their next
  // save anyway.
  if (row.status !== 'ready') {
    return res.status(409).json({ error: 'Only a package handed over for deployment can be approved' });
  }
  const approval = makeApproval({
    by: (req.auth && req.auth.email) || null,
    comment: (req.body || {}).comment,
  });
  const { rows: saved } = await query(
    `UPDATE release_packages
        SET data = jsonb_set(data, ARRAY['approval'], $2::jsonb, true), updated_at = now()
      WHERE id = $1 RETURNING *`,
    [req.params.id, JSON.stringify(approval)]
  );
  const files = await filesByPackage([req.params.id]);
  res.json(Object.assign(packageRowToObj(saved[0]), { files: files.get(req.params.id) || [] }));
});

// POST /api/packages/:id/approve/undo — withdraw the approval. The counterpart of
// the route above and under the same guard: a release cleared and then stopped
// („hold it until the client answers") has to be stoppable in the register, or the
// only record of the stop is a message somewhere.
router.post('/:id/approve/undo', requirePackageApprovalRole, async (req, res) => {
  const { rows } = await query('SELECT project_key FROM release_packages WHERE id = $1', [req.params.id]);
  const row = rows[0];
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (await forbiddenProject(req, row.project_key)) {
    return res.status(403).json({ error: 'Not permitted for this project' });
  }
  const { rows: saved } = await query(
    `UPDATE release_packages SET data = data - 'approval', updated_at = now()
      WHERE id = $1 RETURNING *`,
    [req.params.id]
  );
  const files = await filesByPackage([req.params.id]);
  res.json(Object.assign(packageRowToObj(saved[0]), { files: files.get(req.params.id) || [] }));
});

// DELETE /api/packages/:id — refused once a deployment refers to the package,
// so a deployment cannot end up pointing at a package that no longer exists.
router.delete('/:id', requirePackageRole, async (req, res) => {
  const { rows } = await query('SELECT project_key FROM release_packages WHERE id = $1', [req.params.id]);
  const row = rows[0];
  if (row && await forbiddenProject(req, row.project_key)) {
    return res.status(403).json({ error: 'Not permitted for this project' });
  }
  const { rows: used } = await query(
    `SELECT id FROM deployments WHERE data->>'packageId' = $1 LIMIT 5`,
    [req.params.id]
  );
  if (used.length) {
    return res.status(409).json({
      error: 'This package is used by a deployment',
      deployments: used.map((u) => u.id),
    });
  }
  const { rowCount } = await query('DELETE FROM release_packages WHERE id = $1', [req.params.id]);
  res.json({ deleted: rowCount > 0, id: req.params.id });
});

export default router;
