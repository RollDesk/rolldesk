// Tests for the in-app inbox routing. src/inboxTargets.js is pure, so "why is
// this in my bell drawer" is answered without a database.
//
// The two rules that make the inbox different from the push (and that are the
// easiest to break by copying pushTargets.js): every catalogued event is filed,
// and a muted event is still filed. What it keeps is the authorization half —
// role and project scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INBOX_EVENT_ROLES, INBOX_EVENTS, isInboxEvent, rolesForInboxEvent,
  selectInboxUsers, inboxRecord,
} from '../src/inboxTargets.js';
import { PUSH_EVENTS, PUSH_EVENT_ROLES } from '../src/pushTargets.js';

const rm = (over = {}) => ({ id: 1, email: 'rm@dxc.test', role: 'rm', projects: [], ...over });
const dep = (over = {}) => ({ id: 2, email: 'dep@dxc.test', role: 'installer', projects: ['pik'], ...over });
const tester = (over = {}) => ({ id: 3, email: 'test@dxc.test', role: 'tester', projects: ['pik'], ...over });
const admin = (over = {}) => ({ id: 4, email: 'adm@dxc.test', role: 'admin', projects: [], ...over });
const client = (over = {}) => ({ id: 5, email: 'c@pwpw.test', role: 'client', projects: ['pik'], ...over });

const ALL = [rm(), dep(), tester(), admin(), client()];
const emails = (list) => list.map((u) => u.email).sort();

// ---- the catalogue ---------------------------------------------------------

test('every pushable event is also filed, with the same roles', () => {
  // A second table answering "who cares about a failure" is how the two drift; the
  // push map is spread into this one rather than restated.
  for (const key of PUSH_EVENTS) {
    assert.ok(isInboxEvent(key), `${key} is pushed but not filed`);
    assert.deepEqual(rolesForInboxEvent(key), PUSH_EVENT_ROLES[key], `${key}: role lists differ`);
  }
});

test('the events no push exists for are filed anyway', () => {
  // These are the ones the bell is for: a report, a correction, a comment — worth
  // finding, not worth interrupting anybody about.
  for (const key of ['approval', 'clientComment', 'comment', 'started', 'correction', 'dayReport', 'completed', 'packageCreated']) {
    assert.ok(isInboxEvent(key), `${key} is dispatched by the UI but filed for nobody`);
    assert.ok(!PUSH_EVENTS.includes(key), `${key} is pushed — this list is the non-pushed half`);
  }
});

test('a client account is never a recipient, whatever the event', () => {
  for (const key of INBOX_EVENTS) {
    const got = selectInboxUsers({ eventKey: key, projectKey: 'pik', users: ALL });
    assert.ok(!got.some((u) => u.role === 'client'), `${key} was filed for a client account`);
  }
});

test('an unknown event key files nothing', () => {
  assert.equal(isInboxEvent('somethingElse'), false);
  assert.deepEqual(selectInboxUsers({ eventKey: 'somethingElse', projectKey: 'pik', users: ALL }), []);
  assert.deepEqual(selectInboxUsers({ users: ALL }), []);
});

// ---- the rules -------------------------------------------------------------

test('a muted push is still filed', () => {
  // The whole point of the separation: notify_prefs says „do not interrupt me",
  // which is not „do not tell me". Turning every event off must not empty the
  // drawer.
  const muted = Object.fromEntries(INBOX_EVENTS.map((k) => [k, false]));
  const got = selectInboxUsers({
    eventKey: 'created',
    projectKey: 'pik',
    users: [dep({ notifyPrefs: muted })],
  });
  assert.deepEqual(emails(got), ['dep@dxc.test']);
});

test('the actor is never told about their own action', () => {
  const got = selectInboxUsers({
    eventKey: 'scheduleChanged', projectKey: 'pik', actorEmail: 'RM@DXC.test', users: ALL,
  });
  assert.deepEqual(emails(got), ['adm@dxc.test', 'dep@dxc.test']);
});

test('project scope holds: a deployer hears nothing about a project they were not granted', () => {
  const got = selectInboxUsers({ eventKey: 'created', projectKey: 'other', users: ALL });
  // The deployer is scoped to 'pik'; admins and release managers are unscoped, as
  // everywhere else — and 'created' does not concern a tester.
  assert.deepEqual(emails(got), ['adm@dxc.test']);
});

test('an archived account is not filed for', () => {
  const got = selectInboxUsers({ eventKey: 'completed', projectKey: 'pik', users: [tester({ archived: true }), rm()] });
  assert.deepEqual(emails(got), ['rm@dxc.test']);
});

test('a daily report reaches the planners, not the site', () => {
  assert.deepEqual(
    emails(selectInboxUsers({ eventKey: 'dayReport', projectKey: 'pik', users: ALL })),
    ['adm@dxc.test', 'rm@dxc.test']
  );
});

test('a completed rollout reaches the test team as well', () => {
  assert.deepEqual(
    emails(selectInboxUsers({ eventKey: 'completed', projectKey: 'pik', users: ALL })),
    ['adm@dxc.test', 'rm@dxc.test', 'test@dxc.test']
  );
});

// ---- what one card stores --------------------------------------------------

test('inboxRecord clamps what is filed', () => {
  const row = inboxRecord({
    eventKey: 'created',
    subject: 'S'.repeat(400),
    text: 'B'.repeat(2000),
    projectKey: ' pik ',
    deploymentId: 'DEP-2026-0001',
    actorEmail: 'rm@dxc.test',
  });
  assert.equal(row.subject.length, 300);
  // A composed body carries a changelog; the card is an invitation to open the
  // record, so the pages of it are not filed once per recipient.
  assert.equal(row.body.length, 1200);
  assert.equal(row.projectKey, 'pik');
  assert.equal(row.deploymentId, 'DEP-2026-0001');
  // Absent references are stored as empty and turned into NULL by the insert.
  assert.equal(row.packageId, '');
});

test('inboxRecord tolerates an empty event', () => {
  assert.deepEqual(inboxRecord(), {
    event: '', subject: '', body: '', projectKey: '', deploymentId: '', packageId: '', actorEmail: '',
  });
});

// A guard on the catalogue itself: a role list that names a role nobody has is a
// silent hole — the event would be dispatched and filed for nobody.
test('every role named in the catalogue is a real team role', () => {
  const ROLES = new Set(['admin', 'rm', 'tester', 'installer']);
  for (const [key, roles] of Object.entries(INBOX_EVENT_ROLES)) {
    assert.ok(Array.isArray(roles) && roles.length, `${key}: no roles`);
    roles.forEach((r) => assert.ok(ROLES.has(r), `${key}: unknown role ${r}`));
  }
});
