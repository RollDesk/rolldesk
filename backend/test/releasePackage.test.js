// Tests for the release-package shaping/validation. These run without a
// database because src/releasePackage.js is pure — the router around it only
// does the I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePackage, packageRowToObj, packageChangelogText, nextPackageId,
  PACKAGE_STATUSES,
} from '../src/releasePackage.js';

function body(extra) {
  return Object.assign({
    projectKey: 'acme-core',
    apps: [{ name: 'core', version: '3.2.0' }],
    issues: [{ id: 'HALO-1234', description: 'Login loop after session timeout' }],
  }, extra);
}

test('a well-formed package is accepted and shaped', () => {
  const r = normalizePackage(body({ name: 'August hotfix', status: 'ready' }), {
    createdBy: 'tester@example.com',
  });
  assert.equal(r.ok, true);
  assert.equal(r.data.projectKey, 'acme-core');
  assert.equal(r.data.name, 'August hotfix');
  assert.equal(r.data.status, 'ready');
  assert.equal(r.data.createdBy, 'tester@example.com');
  assert.deepEqual(r.data.data.apps, [{ name: 'core', version: '3.2.0' }]);
  assert.deepEqual(r.data.data.issues, [
    { id: 'HALO-1234', description: 'Login loop after session timeout' },
  ]);
});

test('projectKey is required, in either casing', () => {
  assert.equal(normalizePackage(body({ projectKey: '   ' })).ok, false);
  const snake = normalizePackage({
    project_key: 'acme-core',
    apps: [{ name: 'core', version: '1.0.0' }],
  });
  assert.equal(snake.ok, true);
  assert.equal(snake.data.projectKey, 'acme-core');
});

test('a package needs at least one application with a version', () => {
  assert.equal(normalizePackage(body({ apps: [] })).ok, false);
  // An app without a version is dropped, which leaves nothing deployable.
  assert.equal(normalizePackage(body({ apps: [{ name: 'core' }] })).ok, false);
  assert.equal(normalizePackage(body({ apps: [{ version: '1.0.0' }] })).ok, false);
});

test('status falls back to draft and only known values are kept', () => {
  assert.deepEqual(PACKAGE_STATUSES, ['draft', 'ready']);
  assert.equal(normalizePackage(body()).data.status, 'draft');
  assert.equal(normalizePackage(body({ status: 'shipped' })).data.status, 'draft');
});

test('ready requires at least one issue', () => {
  const r = normalizePackage(body({ status: 'ready', issues: [] }));
  assert.equal(r.ok, false);
  assert.match(r.error, /ready/);
  // The same package as a draft is fine — the test team fills the list in later.
  assert.equal(normalizePackage(body({ issues: [] })).ok, true);
});

test('a bare string issue is accepted', () => {
  const r = normalizePackage(body({ issues: ['HALO-1', ' HALO-2 ', '', null] }));
  assert.deepEqual(r.data.data.issues, [
    { id: 'HALO-1', description: '' },
    { id: 'HALO-2', description: '' },
  ]);
});

test('an issue without an id is dropped, and the id is stored verbatim', () => {
  const r = normalizePackage(body({
    issues: [
      { description: 'no id here' },
      { id: 'halo#42/A', description: 'odd but valid tracker id' },
    ],
  }));
  assert.deepEqual(r.data.data.issues, [
    { id: 'halo#42/A', description: 'odd but valid tracker id' },
  ]);
});

test('oversized collections are refused rather than stored', () => {
  const apps = Array.from({ length: 101 }, (_, i) => ({ name: 'a' + i, version: '1.0.0' }));
  assert.equal(normalizePackage(body({ apps })).ok, false);
  const issues = Array.from({ length: 501 }, (_, i) => 'HALO-' + i);
  assert.equal(normalizePackage(body({ issues })).ok, false);
});

test('long text is clamped, not rejected', () => {
  const r = normalizePackage(body({
    issues: [{ id: 'X'.repeat(200), description: 'y'.repeat(5000) }],
    notes: 'n'.repeat(5000),
  }));
  assert.equal(r.ok, true);
  assert.equal(r.data.data.issues[0].id.length, 100);
  assert.equal(r.data.data.issues[0].description.length, 2000);
  assert.equal(r.data.data.notes.length, 2000);
});

test('an explicit id wins over the body id', () => {
  const r = normalizePackage(body({ id: 'PKG-2026-0009' }), { id: 'PKG-2026-0001' });
  assert.equal(r.data.id, 'PKG-2026-0001');
  assert.equal(normalizePackage(body()).data.id, null);
});

test('packageRowToObj puts the lifted columns back on the JSONB', () => {
  const obj = packageRowToObj({
    id: 'PKG-2026-0002',
    project_key: 'acme-core',
    name: null,
    status: 'ready',
    created_by: 'tester@example.com',
    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-02T10:00:00.000Z',
    data: { apps: [{ name: 'core', version: '3.2.0' }], issues: [] },
  });
  assert.equal(obj.id, 'PKG-2026-0002');
  assert.equal(obj.projectKey, 'acme-core');
  assert.equal(obj.name, undefined);
  assert.equal(obj.createdBy, 'tester@example.com');
  assert.deepEqual(obj.apps, [{ name: 'core', version: '3.2.0' }]);
  assert.equal(packageRowToObj(null), null);
  // A row whose data column is somehow not an object must not throw.
  assert.equal(packageRowToObj({ id: 'X', data: 'oops' }).id, 'X');
});

test('the changelog text lists one issue per line', () => {
  assert.equal(
    packageChangelogText({
      issues: [
        { id: 'HALO-1', description: 'Fixed the login loop' },
        { id: 'HALO-2', description: '' },
      ],
    }),
    'HALO-1 — Fixed the login loop\nHALO-2'
  );
  assert.equal(packageChangelogText(null), '');
  assert.equal(packageChangelogText({ issues: 'nope' }), '');
});

test('ids run sequentially within a year and ignore other years', () => {
  assert.equal(nextPackageId([], 2026), 'PKG-2026-0001');
  assert.equal(nextPackageId(['PKG-2026-0001', 'PKG-2026-0002'], 2026), 'PKG-2026-0003');
  assert.equal(nextPackageId(['PKG-2025-0044'], 2026), 'PKG-2026-0001');
  // A gap does not get reused: the highest number wins.
  assert.equal(nextPackageId(['PKG-2026-0001', 'PKG-2026-0007'], 2026), 'PKG-2026-0008');
  assert.equal(nextPackageId(['PKG-2026-oops', null, undefined], 2026), 'PKG-2026-0001');
});
