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
  return projects.includes(dep.project_key); // installer (and any other scoped role)
}
