// Tests for the release-package shaping/validation. These run without a
// database because src/releasePackage.js is pure — the router around it only
// does the I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePackage, packageRowToObj, packageChangelogText, nextPackageId,
  packageIssueIds, packageReportingOffices, prioritizeReportingTargets,
  isInstructionKind, stripAdminInfoFromPackage, PACKAGE_STATUSES, FILE_KINDS,
  requestedFileKind, isInstructionFile, visiblePackageFiles,
  isPackageApproved, packageBlockReason, makeApproval, normalizeApproval,
  approvalSurvivesEdit,
} from '../src/releasePackage.js';

function body(extra) {
  return Object.assign({
    projectKey: 'acme-core',
    apps: [{ name: 'core', version: '3.2.0' }],
    issues: [{ id: '41231', haloTicket: 'HALO-1234', office: 'Central branch' }],
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
    { id: '41231', haloTicket: 'HALO-1234', office: 'Central branch' },
  ]);
  assert.equal(r.data.data.changes, 'The login loop after a session timeout is gone.');
});

// Where the build for a version is. A deployer works from the version and then
// has to find the file, so the address is typed on the package that names it.
test('an application keeps the address of its build', () => {
  const r = normalizePackage(body({
    apps: [{ name: 'core', version: '3.2.0', url: '  https://builds.example.com/core-3.2.0.msi  ' }],
  }));
  assert.deepEqual(r.data.data.apps, [
    { name: 'core', version: '3.2.0', url: 'https://builds.example.com/core-3.2.0.msi' },
  ]);
  // A UNC share is as common as a URL here and is stored exactly as typed — this
  // is an address to hand to a deployer, not something we resolve.
  const unc = normalizePackage(body({
    apps: [{ name: 'core', version: '3.2.0', url: '\\\\builds\\release\\core\\setup.msi' }],
  }));
  assert.equal(unc.data.data.apps[0].url, '\\\\builds\\release\\core\\setup.msi');
  // No address is the normal state for a package assembled before the field
  // existed, and stays absent rather than becoming an empty string.
  const none = normalizePackage(body({ apps: [{ name: 'core', version: '3.2.0', url: '  ' }] }));
  assert.deepEqual(none.data.data.apps, [{ name: 'core', version: '3.2.0' }]);
  // A hostile caller must not be able to store an unbounded blob in the JSONB.
  const long = normalizePackage(body({
    apps: [{ name: 'core', version: '3.2.0', url: 'h'.repeat(2000) }],
  }));
  assert.equal(long.data.data.apps[0].url.length, 1000);
});

// The description used to live per issue; it is now one block for the package,
// so an issue entry carries identifiers only.
test('an issue carries identifiers only — a per-issue description is not stored', () => {
  const r = normalizePackage(body({
    issues: [{ id: '41231', description: 'what changed', haloTicket: 'HALO-9' }],
  }));
  assert.deepEqual(r.data.data.issues, [{ id: '41231', haloTicket: 'HALO-9' }]);
});

test('an issue with only a work item id keeps the optional fields absent', () => {
  const r = normalizePackage(body({ issues: [{ id: '41231', haloTicket: '  ', office: '' }] }));
  assert.deepEqual(r.data.data.issues, [{ id: '41231' }]);
});

// The work item's own title, read by the lookup rather than typed. Stored so the
// issue list says what each id is without a lookup per row on every page.
test('an issue keeps the work item title the lookup found', () => {
  const r = normalizePackage(body({
    issues: [{ id: '41231', haloTicket: 'HALO-9', title: '  Login loop after a session timeout  ' }],
  }));
  assert.deepEqual(r.data.data.issues, [
    { id: '41231', haloTicket: 'HALO-9', title: 'Login loop after a session timeout' },
  ]);
  // A work item with no title stays absent rather than storing an empty string.
  const blank = normalizePackage(body({ issues: [{ id: '41231', title: '   ' }] }));
  assert.deepEqual(blank.data.data.issues, [{ id: '41231' }]);
});

// The state travels with the title for the same reason: reopening the editor has
// to show what the lookup found rather than an empty column. It is a snapshot of
// the day the issue was added — the id stays a link so today's value is one click
// away.
test('an issue keeps the work item state the lookup found', () => {
  const r = normalizePackage(body({
    issues: [{ id: '41231', title: 'Login loop', state: '  Resolved  ' }],
  }));
  assert.deepEqual(r.data.data.issues, [
    { id: '41231', title: 'Login loop', state: 'Resolved' },
  ]);
  assert.deepEqual(
    normalizePackage(body({ issues: [{ id: '41231', state: '  ' }] })).data.data.issues,
    [{ id: '41231' }]
  );
  // A tracker naming its states at length must not push a long string into the
  // JSONB the list has to lay out.
  const long = normalizePackage(body({ issues: [{ id: '41231', state: 'S'.repeat(200) }] }));
  assert.equal(long.data.data.issues[0].state.length, 60);
});

// The field is stored as `haloTicket` now. The tracker's own name for it and both
// casings still parse, so a package stored before the rename — and any caller
// written against it — keeps working.
test('the ticket field is accepted under its old names and either casing', () => {
  for (const issue of [
    { id: '41231', haloTicket: 'HALO-7' },
    { id: '41231', halo_ticket: 'HALO-7' },
    { id: '41231', smProblem: 'HALO-7' },
    { id: '41231', sm_problem: 'HALO-7' },
  ]) {
    const r = normalizePackage(body({ issues: [issue] }));
    assert.equal(r.data.data.issues[0].haloTicket, 'HALO-7', JSON.stringify(issue));
    assert.equal(r.data.data.issues[0].smProblem, undefined);
  }
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

// A release can carry work no tracker item was filed for, so the issue list is
// not what makes a package ready — the description of the changes is.
test('ready does not require an issue', () => {
  const r = normalizePackage(body({ status: 'ready', issues: [] }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.data.issues, []);
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
      { haloTicket: 'HALO-1', office: 'no work item id here' },
      { id: 'halo#42/A', haloTicket: 'SM/2026 07', office: 'Tax office Kraków' },
    ],
  }));
  assert.deepEqual(r.data.data.issues, [
    { id: 'halo#42/A', haloTicket: 'SM/2026 07', office: 'Tax office Kraków' },
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
    issues: [{ id: 'X'.repeat(200), haloTicket: 'S'.repeat(200), office: 'o'.repeat(500) }],
    changes: 'c'.repeat(30000),
    notes: 'n'.repeat(5000),
  }));
  assert.equal(r.ok, true);
  assert.equal(r.data.data.issues[0].id.length, 100);
  assert.equal(r.data.data.issues[0].haloTicket.length, 100);
  assert.equal(r.data.data.issues[0].office.length, 200);
  // The description of the whole release gets far more room than the per-issue
  // text it replaced, and the deployer instructions the same — truncating an
  // install step is worse than storing a long one.
  assert.equal(r.data.data.changes.length, 20000);
  assert.equal(r.data.data.notes.length, 2000);
  const long = normalizePackage(body({ instructions: 'i'.repeat(30000) }));
  assert.equal(long.data.data.instructions.length, 20000);
});

// The instructions describe the build, not the day it goes out, so they are the
// package's — a deployment shows them read-only from the package it used. They
// were typed on the deployment as `installerNotes`, which is still accepted so a
// caller written against that keeps working.
test('deployer instructions belong to the package, under either name', () => {
  const r = normalizePackage(body({ instructions: 'Stop the service, then run migrate.' }));
  assert.equal(r.data.data.instructions, 'Stop the service, then run migrate.');
  const legacy = normalizePackage(body({ installerNotes: 'Stop the service.' }));
  assert.equal(legacy.data.data.instructions, 'Stop the service.');
  // Absent stays absent rather than becoming an empty string in the JSONB.
  assert.equal(normalizePackage(body()).data.data.instructions, undefined);
});

// A release verified on the test instance and never promoted. Marked by the test
// team, read by the release manager: the deployment form starts on the test-only
// path so nobody plans, approves or escalates a production rollout that is not
// going to happen.
test('a package can say it is only ever installed on a test environment', () => {
  assert.equal(normalizePackage(body({ testOnly: true })).data.data.testOnly, true);
  assert.equal(normalizePackage(body({ testOnly: 'true' })).data.data.testOnly, true);
  // Absent stays absent rather than storing `false` on every package ever saved.
  assert.equal(normalizePackage(body()).data.data.testOnly, undefined);
  assert.equal(normalizePackage(body({ testOnly: false })).data.data.testOnly, undefined);
  // Only the two spellings above turn it on: a stray string must not be read as
  // "skip production", because that is what decides whether a rollout is planned.
  assert.equal(normalizePackage(body({ testOnly: 'yes' })).data.data.testOnly, undefined);
  assert.equal(normalizePackage(body({ testOnly: 1 })).data.data.testOnly, undefined);
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

// ---- File kinds and the client-facing view of a package ----
//
// The instructions and the deployer files moved onto the package, so the
// visibility rule they were subject to on the deployment had to move with them.

test('only the changelog kind is client-facing; anything else is instructions', () => {
  assert.deepEqual(FILE_KINDS, ['changelog', 'instructions']);
  assert.equal(isInstructionKind('changelog'), false);
  assert.equal(isInstructionKind('instructions'), true);
  // Unrecognised, empty and absent all fall to the narrower audience: a file we
  // cannot classify must not leak to a client because of a typo or a null.
  assert.equal(isInstructionKind('Changelog'), true);
  assert.equal(isInstructionKind('script'), true);
  assert.equal(isInstructionKind(''), true);
  assert.equal(isInstructionKind(null), true);
  assert.equal(isInstructionKind(undefined), true);
});

test('the client view drops the instructions and their files, keeping the changelog', () => {
  const pkg = {
    id: 'PKG-2026-0001',
    changes: 'The login loop is gone.',
    instructions: 'Stop the service, then run migration.sql.',
    files: [
      { id: '1', filename: 'release-notes.pdf', kind: 'changelog' },
      { id: '2', filename: 'install.ps1', kind: 'instructions' },
      { id: '3', filename: 'mystery.bin' },
    ],
  };
  const out = stripAdminInfoFromPackage(pkg);
  assert.equal('instructions' in out, false);
  assert.equal(out.changes, 'The login loop is gone.');
  assert.deepEqual(out.files.map((f) => f.id), ['1']);
  // The input is not mutated: the same row is also returned unstripped to the
  // team, and a shared object would have been emptied for everyone.
  assert.equal(pkg.instructions, 'Stop the service, then run migration.sql.');
  assert.equal(pkg.files.length, 3);
});

// The build address is where the installer is fetched from during a rollout, so
// it belongs to the deployer's half of the package — usually a path on an
// internal share. What is being released stays visible; how to obtain it does not.
test('the client view drops the build addresses but keeps the versions', () => {
  const pkg = {
    id: 'PKG-2026-0003',
    apps: [
      { name: 'core', version: '3.2.0', url: '\\\\builds\\release\\core\\setup.msi' },
      { name: 'portal', version: '1.4.1' },
    ],
  };
  const out = stripAdminInfoFromPackage(pkg);
  assert.deepEqual(out.apps, [
    { name: 'core', version: '3.2.0' },
    { name: 'portal', version: '1.4.1' },
  ]);
  // The stored row is shared with the unstripped team view, so it must not be
  // mutated in place.
  assert.equal(pkg.apps[0].url, '\\\\builds\\release\\core\\setup.msi');
});

test('the client view survives a package with no files at all', () => {
  assert.deepEqual(stripAdminInfoFromPackage({ id: 'PKG-2026-0002' }), { id: 'PKG-2026-0002' });
  assert.deepEqual(stripAdminInfoFromPackage({ files: null }), { files: null });
  assert.equal(stripAdminInfoFromPackage(null), null);
  assert.equal(stripAdminInfoFromPackage('nope'), 'nope');
});

// What the upload route stores in the `kind` column. The visibility rules below
// are only as good as this value, so an unknown kind has to land on the
// client-facing side deliberately rather than by accident: an uploader who does
// not say what a file is gets the changelog default, and one who says something
// unrecognised gets it too — but never a third class that no rule covers.
test('an upload is stored as one of the two known kinds and nothing else', () => {
  assert.equal(requestedFileKind({ kind: 'instructions' }), 'instructions');
  assert.equal(requestedFileKind({ kind: 'changelog' }), 'changelog');
  // The multipart field is sometimes called `type`; casing and padding are the
  // browser's business, not a new kind.
  assert.equal(requestedFileKind({ type: 'INSTRUCTIONS' }), 'instructions');
  assert.equal(requestedFileKind({ kind: '  instructions  ' }), 'instructions');
  // Anything else is a changelog file, which is the field the form defaults to.
  assert.equal(requestedFileKind({ kind: 'internal' }), 'changelog');
  assert.equal(requestedFileKind({ kind: 'instruction' }), 'changelog');
  assert.equal(requestedFileKind({}), 'changelog');
  assert.equal(requestedFileKind(null), 'changelog');
  assert.equal(requestedFileKind(undefined), 'changelog');
  // Whatever a caller sends — and a multipart field can arrive as an array when
  // it is repeated — the result is one of the two known kinds. That is the
  // guarantee the visibility rules rest on; which of the two a repeated field
  // lands on is not worth defining beyond that.
  for (const kind of [['instructions'], ['changelog'], 42, true, {}, [], null]) {
    assert.ok(FILE_KINDS.includes(requestedFileKind({ kind })), JSON.stringify(kind));
  }
});

// isInstructionFile is the same rule as isInstructionKind, asked of a database
// row. The route reads the column through it, so the row shape matters: a SELECT
// that forgets `kind` yields rows with kind === undefined, which must classify as
// instructions and hide the file rather than expose one.
test('a stored row is classified by its kind column, and a missing column hides the file', () => {
  assert.equal(isInstructionFile({ id: '1', kind: 'changelog' }), false);
  assert.equal(isInstructionFile({ id: '2', kind: 'instructions' }), true);
  assert.equal(isInstructionFile({ id: '3' }), true);
  assert.equal(isInstructionFile(null), true);
});

// The file-list rule the GET /api/packages/:id/attachments route applies. Kept
// pure so both halves of it can be checked without a database: who is asking,
// and whether their project shares deployer material.
const FILES = [
  { id: '1', filename: 'release-notes.pdf', kind: 'changelog' },
  { id: '2', filename: 'install.ps1', kind: 'instructions' },
  { id: '3', filename: 'mystery.bin' },
];
const ids = (list) => list.map((f) => f.id);

test('a team account sees every file on a package, whatever its kind', () => {
  for (const sharesAdminInfo of [false, true]) {
    assert.deepEqual(
      ids(visiblePackageFiles(FILES, { isClient: false, sharesAdminInfo })),
      ['1', '2', '3'],
      `sharesAdminInfo=${sharesAdminInfo}`
    );
  }
});

test('a client gets the changelog files only, unless the project shares admin info', () => {
  assert.deepEqual(ids(visiblePackageFiles(FILES, { isClient: true, sharesAdminInfo: false })), ['1']);
  // The project policy is an opt-in to showing deployer material, so it restores
  // the whole list rather than only the instruction files.
  assert.deepEqual(
    ids(visiblePackageFiles(FILES, { isClient: true, sharesAdminInfo: true })),
    ['1', '2', '3']
  );
});

// An absent flag must mean "not a client" the same way the route's `isClient(req)`
// returns false for a request with no role — but an absent *policy* must not read
// as an opt-in, which is why the client branch is the one that filters.
test('the narrow answer is the default when the caller is not described', () => {
  assert.deepEqual(ids(visiblePackageFiles(FILES, {})), ['1', '2', '3']);
  assert.deepEqual(ids(visiblePackageFiles(FILES)), ['1', '2', '3']);
  assert.deepEqual(ids(visiblePackageFiles(FILES, { isClient: true })), ['1']);
});

test('a package with no files, or a non-list, yields an empty list rather than throwing', () => {
  for (const files of [[], null, undefined, 'nope', { 0: 'x' }]) {
    assert.deepEqual(visiblePackageFiles(files, { isClient: true }), [], JSON.stringify(files));
    assert.deepEqual(visiblePackageFiles(files, { isClient: false }), [], JSON.stringify(files));
  }
});

test('the stored list is not mutated by the client-facing filter', () => {
  const files = FILES.map((f) => Object.assign({}, f));
  visiblePackageFiles(files, { isClient: true, sharesAdminInfo: false });
  assert.equal(files.length, 3);
});

// ---- Approval for deployment ------------------------------------------------
//
// The project manager's clearance. The process always had this step and RollDesk
// never did, so a release manager could plan a rollout from a package nobody had
// cleared — and the clearance itself lived in a mail thread.

test('a package is deployable only when it is both handed over and approved', () => {
  const approval = makeApproval({ by: 'pm@dxc.test' });
  assert.equal(isPackageApproved({ status: 'ready', approval }), true);
  // Handed over, nobody cleared it: this is the case the gate exists for.
  assert.equal(isPackageApproved({ status: 'ready' }), false);
  // Cleared, then put back into draft by the test team.
  assert.equal(isPackageApproved({ status: 'draft', approval }), false);
  assert.equal(isPackageApproved({}), false);
  assert.equal(isPackageApproved(null), false);
});

test('the block reason says which half is missing', () => {
  assert.equal(packageBlockReason({ status: 'draft' }), 'draft');
  assert.equal(packageBlockReason({ status: 'ready' }), 'awaiting-approval');
  assert.equal(packageBlockReason({ status: 'ready', approval: makeApproval({ by: 'pm@dxc.test' }) }), '');
});

test('an approval is shaped and its comment bounded', () => {
  const a = makeApproval({ by: '  pm@dxc.test  ', comment: 'c'.repeat(5000), at: '2026-08-20T10:00:00Z' });
  assert.equal(a.by, 'pm@dxc.test');
  assert.equal(a.at, '2026-08-20T10:00:00Z');
  assert.equal(a.comment.length, 2000);
  // No comment is the normal case, and stores nothing rather than an empty string.
  assert.equal(makeApproval({ by: 'pm@dxc.test' }).comment, undefined);
  // The timestamp is what makes an approval an approval, so a stored blob without
  // one is not read as one.
  assert.equal(normalizeApproval({ by: 'pm@dxc.test' }), null);
  assert.equal(normalizeApproval(null), null);
  assert.equal(normalizeApproval('yes'), null);
  assert.equal(normalizeApproval([]), null);
  // The migration's backfill: approved, with nobody named, and marked as such.
  const legacy = normalizeApproval({ by: null, at: '2026-08-20T10:00:00Z', legacy: true });
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.by, null);
});

test('an approval survives a correction to the prose but not a change to the build', () => {
  const base = { apps: [{ name: 'Driver', version: '1.2.3' }], changes: 'first draft' };
  // The description, the notes and the issue list do not change what is installed.
  assert.equal(approvalSurvivesEdit(base, Object.assign({}, base, { changes: 'reworded' })), true);
  assert.equal(approvalSurvivesEdit(base, Object.assign({}, base, { issues: [{ id: '1' }] })), true);
  // The order of the applications is not a change either.
  const two = { apps: [{ name: 'A', version: '1' }, { name: 'B', version: '2' }] };
  const swapped = { apps: [{ name: 'B', version: '2' }, { name: 'A', version: '1' }] };
  assert.equal(approvalSurvivesEdit(two, swapped), true);
  // A different version is a different build — the PM cleared the other one.
  assert.equal(approvalSurvivesEdit(base, { apps: [{ name: 'Driver', version: '1.2.4' }] }), false);
  // So is an application added or dropped.
  assert.equal(approvalSurvivesEdit(base, { apps: base.apps.concat([{ name: 'X', version: '9' }]) }), false);
  assert.equal(approvalSurvivesEdit(base, { apps: [] }), false);
  // And so is turning it into a test-only release.
  assert.equal(approvalSurvivesEdit(base, Object.assign({}, base, { testOnly: true })), false);
});

test('the API object reports the approval and the deployable flag', () => {
  const row = {
    id: 'PKG-2026-0007', project_key: 'pik', status: 'ready',
    data: { apps: [{ name: 'A', version: '1' }], approval: { by: 'pm@dxc.test', at: '2026-08-20T10:00:00Z' } },
  };
  const obj = packageRowToObj(row);
  assert.equal(obj.approved, true);
  assert.equal(obj.approval.by, 'pm@dxc.test');
  // A draft with a stale approval blob is not deployable, and says so in one field.
  assert.equal(packageRowToObj(Object.assign({}, row, { status: 'draft' })).approved, false);
  // Nothing stored: no approval key at all rather than a null the UI has to test for.
  assert.equal(packageRowToObj({ id: 'x', status: 'draft', data: {} }).approval, undefined);
});
