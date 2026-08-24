// Role-based access control helpers for the data API.
//
// Client accounts are external stakeholders: they may only look at the
// deployments of the projects they belong to (and never internal ones). They
// must not create/modify projects or deployments, see the change history, send
// notifications, or reach another client's data. The frontend hides those
// controls, but the API enforces it too so a client cannot bypass the UI by
// calling the endpoints directly.
import { query } from './db.js';
import { visibleProjectKeys } from './projectClient.js';

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
  const { rows } = await query('SELECT role, projects, client_key FROM users WHERE id = $1', [req.auth.sub]);
  const row = rows[0] || {};
  let projects = Array.isArray(row.projects) ? row.projects.map(String) : [];
  const clientKey = row.client_key || null;

  // For a client account the grant list alone is not the whole rule: a project
  // can be MOVED to another client (see projectClient.js), and from that moment
  // the old client's accounts must not read it. The move revokes their grants,
  // but a grant re-added by hand, or a move interrupted half-way, would still be
  // one client reading another's deliveries — so the scope is intersected with
  // the projects that actually belong to this client. Projects whose client was
  // never recorded are left in, so nothing that worked before stops working.
  if (row.role === 'client' && clientKey && projects.length) {
    const { rows: owners } = await query(
      `SELECT key, data->>'client' AS client FROM projects WHERE key = ANY($1::text[])`,
      [projects]
    );
    const byKey = new Map(owners.map((r) => [String(r.key), r.client || '']));
    projects = visibleProjectKeys(projects, byKey, clientKey);
  }

  req._clientScope = { projects, clientKey };
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

// The project manager: the person who decides whether a finished release goes out
// at all. A role of their own rather than a release manager with an extra button —
// the two are different people in this process, the release manager plans the
// rollout of what the project manager has cleared, and giving a PM a release
// manager's account would hand them every write in the application.
export function isPM(req) {
  return !!(req.auth && req.auth.role === 'pm');
}

// Roles whose reach is the list of projects granted on their account, rather
// than everything (admin/rm) or a client's own non-internal records. Read
// endpoints must narrow to `userScope` for these, or a tester assigned to one
// project would read every other project's deployments.
// A project manager manages projects, plural but not all of them: the scope is the
// point of the role, so a PM approves releases for their own projects and does not
// see another client's.
const SCOPED_ROLES = new Set(['installer', 'tester', 'pm']);

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

// Reject anyone but an administrator. For the handful of data-API routes that are
// not "may this role write?" but "may this role change who sees what?" — moving a
// project to another client is one: it decides which client accounts may read the
// project's deployments and which webhooks its events are sent to, and clients
// themselves are administered nowhere else. (The Users routes carry their own
// copy of this check because that whole router is admin-only.)
export function requireAdminRole(req, res, next) {
  if (!req.auth || req.auth.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator role required' });
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

// Who may clear a release for deployment. Deliberately not the roles that assemble
// packages: a tester approving their own build is the gate approving itself, and a
// release manager approving what they are about to plan is the same thing one step
// later. An administrator is included because an instance whose only PM is away
// must not be a stopped process.
const PACKAGE_APPROVAL_ROLES = new Set(['admin', 'pm']);

export function requirePackageApprovalRole(req, res, next) {
  const role = (req.auth && req.auth.role) || '';
  if (!PACKAGE_APPROVAL_ROLES.has(role)) {
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
  return projects.includes(dep.project_key); // installer/tester/pm (and any other scoped role)
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
