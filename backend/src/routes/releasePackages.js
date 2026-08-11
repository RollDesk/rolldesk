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
  isClient, isInstaller, isTester, clientScope, userScope, requirePackageRole,
} from '../rbac.js';
import {
  normalizePackage, packageRowToObj, nextPackageId,
} from '../releasePackage.js';

const router = Router();

// Project scope for a read. Returns null when the caller sees everything, or an
// array of project keys (possibly empty — meaning "nothing").
async function readScope(req) {
  if (isClient(req)) return (await clientScope(req)).projects;
  if (isInstaller(req) || isTester(req)) return (await userScope(req)).projects;
  return null; // admin / rm
}

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
  res.json(rows.map(packageRowToObj));
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
  res.json(packageRowToObj(row));
});

// A tester may only write within the projects they were granted; admins and
// release managers are unscoped, like everywhere else.
async function forbiddenProject(req, projectKey) {
  if (!isTester(req)) return false;
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
  return packageRowToObj(rows[0]);
}

// POST /api/packages — create. The id is generated unless one is supplied.
router.post('/', requirePackageRole, async (req, res) => {
  const actor = (req.auth && req.auth.email) || null;
  const shaped = normalizePackage(req.body, { createdBy: actor });
  if (!shaped.ok) return res.status(422).json({ error: shaped.error });
  if (await forbiddenProject(req, shaped.data.projectKey)) {
    return res.status(403).json({ error: 'Not permitted for this project' });
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
    'SELECT project_key, created_by FROM release_packages WHERE id = $1',
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
  res.json(await upsert(req.params.id, shaped.data));
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
