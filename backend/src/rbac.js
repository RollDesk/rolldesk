// Role-based access control helpers for the data API.
//
// Client accounts are external stakeholders: they may only look at the
// deployments of the projects they belong to (and never internal ones). They
// must not create/modify projects or deployments, see the change history, send
// notifications, or reach another client's data. The frontend hides those
// controls, but the API enforces it too so a client cannot bypass the UI by
// calling the endpoints directly.
import { query } from './db.js';

// Reject the request when the caller is a client account. Use on any
// create/update/delete or team-only endpoint.
export function forbidClient(req, res, next) {
  if (req.auth && req.auth.role === 'client') {
    return res.status(403).json({ error: 'Not permitted for client accounts' });
  }
  next();
}

// Load (once per request) the signed-in client's project scope from the users
// table: the projects they were granted and their client key. Used to filter
// read endpoints down to what the client is allowed to see.
export async function clientScope(req) {
  if (req._clientScope) return req._clientScope;
  const { rows } = await query('SELECT projects, client_key FROM users WHERE id = $1', [req.auth.sub]);
  const row = rows[0] || {};
  const projects = Array.isArray(row.projects) ? row.projects.map(String) : [];
  req._clientScope = { projects, clientKey: row.client_key || null };
  return req._clientScope;
}

export function isClient(req) {
  return !!(req.auth && req.auth.role === 'client');
}

export function isInstaller(req) {
  return !!(req.auth && req.auth.role === 'installer');
}

export function isTester(req) {
  return !!(req.auth && req.auth.role === 'tester');
}

// Roles whose reach is the list of projects granted on their account, rather
// than everything (admin/rm) or a client's own non-internal records. Read
// endpoints must narrow to `userScope` for these, or a tester assigned to one
// project would read every other project's deployments.
const SCOPED_ROLES = new Set(['installer', 'tester']);

export function isScopedRole(req) {
  return SCOPED_ROLES.has((req.auth && req.auth.role) || '');
}

// Roles allowed to change projects and deployments. `forbidClient` only ever
// rejected clients, so every role added since inherited a release manager's
// write access by default — a tester, whose whole job is assembling release
// packages, could have created and deleted deployments through the API. Guard
// write routes with this instead: it names who may write rather than who may
// not, so the next role added is locked out until someone decides otherwise.
const WRITE_ROLES = new Set(['admin', 'rm', 'installer']);

// Reject callers who may read the data API but must not change deployments or
// projects. Use in place of / alongside forbidClient on write endpoints.
export function requireWriteRole(req, res, next) {
  const role = (req.auth && req.auth.role) || '';
  if (!WRITE_ROLES.has(role)) {
    return res.status(403).json({ error: 'Not permitted for this role' });
  }
  next();
}

// Roles allowed to assemble release packages: the test team plus the people who
// plan the releases they feed into.
const PACKAGE_ROLES = new Set(['admin', 'rm', 'tester']);

export function requirePackageRole(req, res, next) {
  const role = (req.auth && req.auth.role) || '';
  if (!PACKAGE_ROLES.has(role)) {
    return res.status(403).json({ error: 'Not permitted for this role' });
  }
  next();
}

// Project scope for the signed-in account (from the users table). Works for any
// role; clients and installers are limited to their granted projects, while
// admins / release managers see everything. Cached per request.
export async function userScope(req) {
  return clientScope(req);
}

// Loads a deployment's ownership columns (project + internal flag) for access
// checks. Returns null when the deployment does not exist.
export async function loadDeploymentAccess(deploymentId) {
  const { rows } = await query(
    'SELECT id, project_key, internal FROM deployments WHERE id = $1',
    [deploymentId]
  );
  return rows[0] || null;
}

// Whether the caller may READ this deployment (and, by extension, its
// attachments). Mirrors the scoping used by the deployments routes: admins and
// release managers see everything; clients only their granted, non-internal
// projects; installers only their granted projects.
export async function canReadDeployment(req, dep) {
  if (!dep) return false;
  const role = req.auth && req.auth.role;
  if (role === 'admin' || role === 'rm') return true;
  const { projects } = await userScope(req);
  if (role === 'client') return !dep.internal && projects.includes(dep.project_key);
  return projects.includes(dep.project_key); // installer/tester (and any other scoped role)
}

// Loads a release package's ownership columns for access checks, mirroring
// loadDeploymentAccess. Returns null when the package does not exist.
export async function loadPackageAccess(packageId) {
  const { rows } = await query(
    'SELECT id, project_key, status FROM release_packages WHERE id = $1',
    [packageId]
  );
  return rows[0] || null;
}

// Whether the caller may READ this package and its files. Same shape as the
// package list route: admins and release managers see everything, scoped roles
// their granted projects, and a client only a package already handed over —
// a draft is the test team's working copy, not something the client is shown.
export async function canReadPackage(req, pkg) {
  if (!pkg) return false;
  const role = req.auth && req.auth.role;
  if (role === 'admin' || role === 'rm') return true;
  const { projects } = await userScope(req);
  if (!projects.includes(pkg.project_key)) return false;
  if (role === 'client') return pkg.status === 'ready';
  return true;
}

// Project policy: when true, deployer/admin notes on deployments are also
// visible to client accounts (portal + attachment download). Stored in the
// project's JSONB `data` column; defaults to false.
export async function projectSharesAdminInfo(projectKey) {
  if (!projectKey) return false;
  const { rows } = await query(
    `SELECT COALESCE((data->>'clientSeesAdminInfo')::boolean, false) AS flag
       FROM projects WHERE key = $1`,
    [projectKey]
  );
  return !!(rows[0] && rows[0].flag);
}

// Strip deployer/admin-only fields before returning a deployment to a client
// account when the project does not share that information.
export function stripAdminInfoFromDeployment(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Object.assign({}, obj);
  delete out.installerNotes;
  delete out.instructionAttachments;
  return out;
}

// Attachment ids listed on the deployment as deployer-instruction files.
export function instructionAttachmentIds(depData) {
  const list = depData && Array.isArray(depData.instructionAttachments)
    ? depData.instructionAttachments
    : [];
  return new Set(list.map((a) => String(a && a.id)).filter(Boolean));
}
