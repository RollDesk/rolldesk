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
