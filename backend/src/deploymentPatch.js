// Partial-update logic for a deployment, kept pure so it can be tested without
// a database. `PUT /api/deployments/:id` replaces the whole stored object — the
// shape the UI works with, since it always holds the full deployment in memory.
// An automation caller (an `rd_live_…` token in a script or CI job) usually
// wants to change one field, and doing that over PUT means read-modify-write
// with the risk of writing back a truncated object. PATCH merges instead.

// Canonical status values. These are compared as strings in the UI
// (frontend/app/index.html) and stored in the `status` column, so an unknown
// value would render as an unstyled pill and break the status filters — reject
// it at the edge rather than storing it.
export const DEPLOYMENT_STATUSES = ['scheduled', 'installed', 'failed', 'rolledback', 'aborted'];

// Fields that identify or scope a deployment. Changing the project moves the
// record between authorization scopes (who may read it, whose portal shows it),
// which is a different operation from editing it — PATCH refuses and the caller
// can still do it with PUT.
const IMMUTABLE_FIELDS = ['projectKey', 'project_key'];

// Derives the filterable columns from the full deployment object. Shared by the
// PUT upsert and the PATCH merge so the columns can never disagree with `data`.
export function deploymentColumns(obj) {
  const o = obj || {};
  return {
    projectKey: o.projectKey || o.project_key || 'unknown',
    env: o.env || null,
    // A batch deployment is complete when nothing is left scheduled; keep that
    // inference as the fallback for callers that only send counts.
    status: o.status || (o.counts && o.counts.scheduled === 0 ? 'installed' : 'scheduled'),
    internal: !!o.internal,
  };
}

function sameValue(a, b) {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

// Renders a change for the audit detail / timeline entry. Objects and arrays
// are reported by name only — a diff of a nested schedule is not readable in a
// one-line history entry.
function describe(field, from, to) {
  const scalar = (v) => (v === undefined || v === null || v === '' ? '—' : String(v));
  if ((from && typeof from === 'object') || (to && typeof to === 'object')) return field;
  return `${field} ${scalar(from)} → ${scalar(to)}`;
}

// Merges `patch` into the stored deployment object.
//
// The merge is SHALLOW on purpose: a key present in the patch replaces that
// key's whole value, so sending `{counts: {...}}` replaces counts entirely
// rather than merging into it. Keys absent from the patch are left untouched —
// that is the whole point of the endpoint.
//
// Returns `{ ok: true, data, changes }` where `changes` is a list of
// `{ field, from, to }` (empty when the patch was a no-op), or
// `{ ok: false, error }` with a message suitable for a 422 response.
export function mergeDeploymentPatch(current, patch, id) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'Body must be a JSON object of fields to change' };
  }

  const keys = Object.keys(patch);
  if (!keys.length) {
    return { ok: false, error: 'Body must contain at least one field to change' };
  }

  for (const field of IMMUTABLE_FIELDS) {
    if (field in patch) {
      return { ok: false, error: `${field} cannot be changed with PATCH — use PUT to move a deployment to another project` };
    }
  }

  // The id lives in its own column and comes from the path. Accept it in the
  // body only when it agrees, so a caller can round-trip a fetched object.
  if ('id' in patch && id !== undefined && String(patch.id) !== String(id)) {
    return { ok: false, error: 'id in the body does not match the id in the path' };
  }

  if ('status' in patch && !DEPLOYMENT_STATUSES.includes(patch.status)) {
    return { ok: false, error: `Invalid status (expected ${DEPLOYMENT_STATUSES.join(' | ')})` };
  }

  if ('internal' in patch && typeof patch.internal !== 'boolean') {
    return { ok: false, error: 'internal must be a boolean' };
  }

  const data = Object.assign({}, current || {});
  delete data.id;
  const changes = [];
  for (const key of keys) {
    if (key === 'id') continue;
    const from = data[key];
    const to = patch[key];
    if (sameValue(from, to)) continue;
    data[key] = to;
    changes.push({ field: key, from, to });
  }

  return { ok: true, data, changes };
}

// One-line summary of a change list, for the audit entry and the timeline.
export function summarizeChanges(changes) {
  return (changes || []).map((c) => describe(c.field, c.from, c.to)).join(', ');
}
