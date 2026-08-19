// Tests for the PATCH merge logic. These run without a database because
// src/deploymentPatch.js is pure — the route around it only does the I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeDeploymentPatch, summarizeChanges, deploymentColumns, DEPLOYMENT_STATUSES,
  completeBatchRollout,
} from '../src/deploymentPatch.js';

// A deployment as it is stored in the `data` JSONB column: the full object the
// UI works with, minus the id (which lives in its own column).
function storedDeployment() {
  return {
    projectKey: 'acme-core',
    env: 'Production',
    status: 'scheduled',
    mode: 'batch',
    date: '2026-08-03',
    time: '20:00',
    counts: { scheduled: 4, installed: 0 },
    comments: [{ date: '2026-08-01', time: '09:15', author: 'Ada', type: 'note', text: 'window agreed' }],
    apps: [{ name: 'core', version: '3.2.0' }],
  };
}

test('changes only the patched key and leaves the rest of the object intact', () => {
  const current = storedDeployment();
  const r = mergeDeploymentPatch(current, { status: 'installed' }, 'DEP-2026-0032');

  assert.equal(r.ok, true);
  assert.equal(r.data.status, 'installed');
  // Everything else survives — this is the property PUT does not have.
  assert.deepEqual(r.data.counts, { scheduled: 4, installed: 0 });
  assert.deepEqual(r.data.comments, current.comments);
  assert.deepEqual(r.data.apps, current.apps);
  assert.equal(r.data.date, '2026-08-03');
  assert.deepEqual(r.changes, [{ field: 'status', from: 'scheduled', to: 'installed' }]);
});

test('does not mutate the stored object it was given', () => {
  const current = storedDeployment();
  mergeDeploymentPatch(current, { status: 'installed', env: 'Test' }, 'DEP-1');
  assert.equal(current.status, 'scheduled');
  assert.equal(current.env, 'Production');
});

test('reports every changed field, in patch order', () => {
  const r = mergeDeploymentPatch(storedDeployment(), { env: 'Test', time: '22:30' }, 'DEP-1');
  assert.deepEqual(r.changes.map((c) => c.field), ['env', 'time']);
  assert.equal(summarizeChanges(r.changes), 'env Production → Test, time 20:00 → 22:30');
});

test('adds a field that was not stored yet', () => {
  const r = mergeDeploymentPatch(storedDeployment(), { installerNotes: 'reboot after' }, 'DEP-1');
  assert.equal(r.ok, true);
  assert.equal(r.data.installerNotes, 'reboot after');
  assert.deepEqual(r.changes, [{ field: 'installerNotes', from: undefined, to: 'reboot after' }]);
  assert.equal(summarizeChanges(r.changes), 'installerNotes — → reboot after');
});

test('a patch that sets a field to its current value yields no changes', () => {
  const r = mergeDeploymentPatch(storedDeployment(), { status: 'scheduled' }, 'DEP-1');
  assert.equal(r.ok, true);
  assert.deepEqual(r.changes, []);
});

test('an unchanged object value is not reported as a change', () => {
  // Re-sending a fetched object's nested value must not manufacture history.
  const r = mergeDeploymentPatch(storedDeployment(), { counts: { scheduled: 4, installed: 0 } }, 'DEP-1');
  assert.deepEqual(r.changes, []);
});

test('the merge is shallow — a nested object is replaced, not merged', () => {
  const r = mergeDeploymentPatch(storedDeployment(), { counts: { scheduled: 0 } }, 'DEP-1');
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.counts, { scheduled: 0 }, 'installed is gone, not preserved');
  // An object change is summarized by name; a nested diff is unreadable in a
  // one-line history entry.
  assert.equal(summarizeChanges(r.changes), 'counts');
});

test('null explicitly clears a field', () => {
  const r = mergeDeploymentPatch(storedDeployment(), { installerId: null }, 'DEP-1');
  assert.equal(r.ok, true);
  assert.equal(r.data.installerId, null);
});

test('rejects a status outside the canonical list', () => {
  const r = mergeDeploymentPatch(storedDeployment(), { status: 'done' }, 'DEP-1');
  assert.equal(r.ok, false);
  assert.match(r.error, /Invalid status/);
});

test('accepts every canonical status', () => {
  for (const status of DEPLOYMENT_STATUSES) {
    const r = mergeDeploymentPatch(storedDeployment(), { status }, 'DEP-1');
    assert.equal(r.ok, true, `expected ${status} to be accepted`);
  }
});

// A rollout that installed some of its applications and not the others. Both
// neighbours are wrong for it: 'installed' hides the applications that never went
// in, 'failed' hides the ones that did.
test('partial is a canonical status, so an automation caller can record one', () => {
  assert.ok(DEPLOYMENT_STATUSES.includes('partial'));
  const r = mergeDeploymentPatch(storedDeployment(), { status: 'partial' }, 'DEP-1');
  assert.equal(r.ok, true);
  assert.equal(r.data.status, 'partial');
});

test('a patched per-application result is shaped, and a bad one is refused', () => {
  const ok = mergeDeploymentPatch(storedDeployment(), {
    appResults: [
      { name: '  Kolektor  ', status: 'installed' },
      { name: 'Portal', status: 'failed', reason: 'the server stopped answering' },
    ],
  }, 'DEP-1');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.data.appResults, [
    { name: 'Kolektor', status: 'installed' },
    { name: 'Portal', status: 'failed', reason: 'the server stopped answering' },
  ]);
  // The shaped list, not the raw one, is what gets stored — the UI reads it to
  // decide whether the rollout is installed, partial or failed.
  assert.equal(ok.changes.length, 1);
  assert.equal(ok.changes[0].field, 'appResults');

  for (const bad of [[{ status: 'installed' }], [{ name: 'A', status: 'nope' }], 'Portal', 42]) {
    const r = mergeDeploymentPatch(storedDeployment(), { appResults: bad }, 'DEP-1');
    assert.equal(r.ok, false, `expected ${JSON.stringify(bad)} to be refused`);
  }
});

test('rejects a change of project — that moves the record between access scopes', () => {
  for (const field of ['projectKey', 'project_key']) {
    const r = mergeDeploymentPatch(storedDeployment(), { [field]: 'other-client' }, 'DEP-1');
    assert.equal(r.ok, false);
    assert.match(r.error, /use PUT/);
  }
});

test('rejects a non-boolean internal flag', () => {
  const r = mergeDeploymentPatch(storedDeployment(), { internal: 'true' }, 'DEP-1');
  assert.equal(r.ok, false);
  assert.match(r.error, /internal must be a boolean/);
});

test('rejects an empty or non-object body', () => {
  for (const body of [{}, null, undefined, [], 'installed', 42]) {
    const r = mergeDeploymentPatch(storedDeployment(), body, 'DEP-1');
    assert.equal(r.ok, false, `expected ${JSON.stringify(body)} to be rejected`);
  }
});

test('an id in the body is accepted when it matches and ignored as a change', () => {
  const r = mergeDeploymentPatch(storedDeployment(), { id: 'DEP-1', status: 'failed' }, 'DEP-1');
  assert.equal(r.ok, true);
  assert.equal(r.data.id, undefined, 'the id stays in its own column');
  assert.deepEqual(r.changes.map((c) => c.field), ['status']);
});

test('rejects an id in the body that contradicts the path', () => {
  const r = mergeDeploymentPatch(storedDeployment(), { id: 'DEP-2', status: 'failed' }, 'DEP-1');
  assert.equal(r.ok, false);
  assert.match(r.error, /does not match/);
});

test('patching a deployment with no stored data yields just the patch', () => {
  const r = mergeDeploymentPatch(null, { status: 'installed' }, 'DEP-1');
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { status: 'installed' });
});

test('deploymentColumns takes an explicit status over the counts inference', () => {
  assert.equal(deploymentColumns({ status: 'failed', counts: { scheduled: 0 } }).status, 'failed');
});

test('deploymentColumns infers installed from an empty batch queue', () => {
  assert.equal(deploymentColumns({ counts: { scheduled: 0 } }).status, 'installed');
  assert.equal(deploymentColumns({ counts: { scheduled: 3 } }).status, 'scheduled');
});

test('deploymentColumns falls back for a missing project and coerces internal', () => {
  assert.deepEqual(deploymentColumns({}), {
    projectKey: 'unknown', env: null, status: 'scheduled', internal: false,
  });
  assert.equal(deploymentColumns({ internal: 1 }).internal, true);
  assert.equal(deploymentColumns({ project_key: 'acme' }).projectKey, 'acme');
});

test('summarizeChanges is empty for no changes', () => {
  assert.equal(summarizeChanges([]), '');
  assert.equal(summarizeChanges(undefined), '');
});

// --- completing a multi-target rollout -------------------------------------
// A batch deployment shows progress from counts.scheduled, not from `status`, so
// patching the status alone left the row rendering as in-progress.

test('completing a batch rollout empties the pending queue into installed', () => {
  const data = {
    mode: 'batch',
    counts: { scheduled: 88, installed: 312 },
    pendingQueue: ['site-313', 'site-314'],
    failedLocations: [{ location: 'site-7', reason: 'no network' }],
  };
  const extra = completeBatchRollout(data);

  assert.deepEqual(data.counts, { scheduled: 0, installed: 400 });
  assert.deepEqual(data.failedLocations, []);
  assert.deepEqual(data.pendingQueue, []);
  assert.deepEqual(extra.map((c) => c.field), ['counts', 'failedLocations', 'pendingQueue']);
  // The columns derived from the merged object now agree with what the UI draws.
  assert.equal(deploymentColumns(data).status, 'installed');
});

test('completing an already-finished rollout reports no further changes', () => {
  const data = { mode: 'batch', counts: { scheduled: 0, installed: 400 }, pendingQueue: [], failedLocations: [] };
  assert.deepEqual(completeBatchRollout(data), []);
  assert.deepEqual(data.counts, { scheduled: 0, installed: 400 });
});

test('completing a rollout tolerates a record with no counts', () => {
  const data = { mode: 'single', status: 'installed' };
  assert.deepEqual(completeBatchRollout(data), []);
  assert.deepEqual(data, { mode: 'single', status: 'installed' });
});

test('a counts change is summarized as progress, not as a bare field name', () => {
  const extra = completeBatchRollout({ mode: 'batch', counts: { scheduled: 88, installed: 312 } });
  assert.equal(summarizeChanges(extra), 'counts 312/400 → 400/400');
});

test('a partially-replaced counts object is not summarized as a total', () => {
  // The merge is shallow, so `installed` is simply gone here — reporting
  // "0/4 → 0/0" would state a total that was never the case.
  const r = mergeDeploymentPatch(storedDeployment(), { counts: { scheduled: 0 } }, 'DEP-1');
  assert.equal(summarizeChanges(r.changes), 'counts');
});
