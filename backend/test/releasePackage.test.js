// Tests for the release-package shaping/validation. These run without a
// database because src/releasePackage.js is pure — the router around it only
// does the I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePackage, packageRowToObj, packageChangelogText, nextPackageId,
  packageIssueIds, packageReportingOffices, prioritizeReportingTargets,
  PACKAGE_STATUSES,
} from '../src/releasePackage.js';

function body(extra) {
  return Object.assign({
    projectKey: 'acme-core',
    apps: [{ name: 'core', version: '3.2.0' }],
    issues: [{ id: '41231', smProblem: 'HALO-1234', office: 'Central branch' }],
    changes: 'The login loop after a session timeout is gone.',
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
    { id: '41231', smProblem: 'HALO-1234', office: 'Central branch' },
  ]);
  assert.equal(r.data.data.changes, 'The login loop after a session timeout is gone.');
});

// The description used to live per issue; it is now one block for the package,
// so an issue entry carries identifiers only.
test('an issue carries identifiers only — a per-issue description is not stored', () => {
  const r = normalizePackage(body({
    issues: [{ id: '41231', description: 'what changed', smProblem: 'HALO-9' }],
  }));
  assert.deepEqual(r.data.data.issues, [{ id: '41231', smProblem: 'HALO-9' }]);
});

test('an issue with only a work item id keeps the optional fields absent', () => {
  const r = normalizePackage(body({ issues: [{ id: '41231', smProblem: '  ', office: '' }] }));
  assert.deepEqual(r.data.data.issues, [{ id: '41231' }]);
});

test('the SM Problem field is accepted in either casing', () => {
  const r = normalizePackage(body({ issues: [{ id: '41231', sm_problem: 'HALO-7' }] }));
  assert.equal(r.data.data.issues[0].smProblem, 'HALO-7');
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

// A ready package fills the deployment changelog, so an empty description would
// be what the client is sent.
test('ready also requires a description of the changes', () => {
  const r = normalizePackage(body({ status: 'ready', changes: '   ' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /changes/);
  assert.equal(normalizePackage(body({ changes: '' })).ok, true);
});

test('a bare string issue is accepted', () => {
  const r = normalizePackage(body({ issues: ['41231', ' 41232 ', '', null] }));
  assert.deepEqual(r.data.data.issues, [{ id: '41231' }, { id: '41232' }]);
});

test('an issue without an id is dropped, and the ids are stored verbatim', () => {
  const r = normalizePackage(body({
    issues: [
      { smProblem: 'HALO-1', office: 'no work item id here' },
      { id: 'halo#42/A', smProblem: 'SM/2026 07', office: 'Tax office Kraków' },
    ],
  }));
  assert.deepEqual(r.data.data.issues, [
    { id: 'halo#42/A', smProblem: 'SM/2026 07', office: 'Tax office Kraków' },
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
    issues: [{ id: 'X'.repeat(200), smProblem: 'S'.repeat(200), office: 'o'.repeat(500) }],
    changes: 'c'.repeat(30000),
    notes: 'n'.repeat(5000),
  }));
  assert.equal(r.ok, true);
  assert.equal(r.data.data.issues[0].id.length, 100);
  assert.equal(r.data.data.issues[0].smProblem.length, 100);
  assert.equal(r.data.data.issues[0].office.length, 200);
  // The description of the whole release gets far more room than the per-issue
  // text it replaced.
  assert.equal(r.data.data.changes.length, 20000);
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

// The changelog also travels outside the app (the .txt export, the client
// e-mail), where the rendered issue table is not there to carry the ids.
test('the changelog text is the description with the ticket ids underneath', () => {
  assert.equal(
    packageChangelogText({
      changes: 'The login loop is gone.',
      issues: [{ id: '41231' }, { id: '41232' }],
    }),
    'The login loop is gone.\n\n41231, 41232'
  );
  // Either half alone still produces usable text.
  assert.equal(packageChangelogText({ changes: 'Only prose.' }), 'Only prose.');
  assert.equal(packageChangelogText({ issues: [{ id: '41231' }] }), '41231');
  assert.equal(packageChangelogText(null), '');
  assert.equal(packageChangelogText({ issues: 'nope' }), '');
});

test('the issue ids keep the order the test team listed them in', () => {
  assert.deepEqual(
    packageIssueIds({ issues: [{ id: '41232' }, { id: '' }, null, { id: '41231' }] }),
    ['41232', '41231']
  );
  assert.deepEqual(packageIssueIds(null), []);
});

test('reporting offices are deduplicated case-insensitively, keeping the first spelling', () => {
  assert.deepEqual(
    packageReportingOffices({
      issues: [
        { id: '1', office: 'Tax office Kraków' },
        { id: '2', office: 'tax office kraków' },
        { id: '3' },
        { id: '4', office: 'Tax office Gdańsk' },
      ],
    }),
    ['Tax office Kraków', 'Tax office Gdańsk']
  );
  assert.deepEqual(packageReportingOffices(null), []);
});

// The office waiting for the fix should not be the last one to receive it.
test('the reporting offices are moved to the front of the rollout order', () => {
  const targets = [
    { code: 'GD-01', label: 'Tax office Gdańsk' },
    { code: 'WA-01', label: 'Tax office Warszawa' },
    { code: 'KR-01', label: 'Tax office Kraków' },
  ];
  // Matched by label, case-insensitively.
  assert.deepEqual(
    prioritizeReportingTargets(targets, ['tax office kraków']).map((t) => t.code),
    ['KR-01', 'GD-01', 'WA-01']
  );
  // ...or by code, because the ticket may name either.
  assert.deepEqual(
    prioritizeReportingTargets(targets, ['WA-01']).map((t) => t.code),
    ['WA-01', 'GD-01', 'KR-01']
  );
  // Two reporters keep their relative order, and so does everything else.
  assert.deepEqual(
    prioritizeReportingTargets(targets, ['KR-01', 'GD-01']).map((t) => t.code),
    ['GD-01', 'KR-01', 'WA-01']
  );
  // An office nobody registered as a target changes nothing, and neither does
  // an empty list — the original order is returned untouched.
  assert.deepEqual(
    prioritizeReportingTargets(targets, ['Somewhere else']).map((t) => t.code),
    ['GD-01', 'WA-01', 'KR-01']
  );
  assert.deepEqual(prioritizeReportingTargets(targets, []).map((t) => t.code),
    ['GD-01', 'WA-01', 'KR-01']);
  assert.deepEqual(prioritizeReportingTargets(null, ['KR-01']), []);
});

test('ids run sequentially within a year and ignore other years', () => {
  assert.equal(nextPackageId([], 2026), 'PKG-2026-0001');
  assert.equal(nextPackageId(['PKG-2026-0001', 'PKG-2026-0002'], 2026), 'PKG-2026-0003');
  assert.equal(nextPackageId(['PKG-2025-0044'], 2026), 'PKG-2026-0001');
  // A gap does not get reused: the highest number wins.
  assert.equal(nextPackageId(['PKG-2026-0001', 'PKG-2026-0007'], 2026), 'PKG-2026-0008');
  assert.equal(nextPackageId(['PKG-2026-oops', null, undefined], 2026), 'PKG-2026-0001');
});
