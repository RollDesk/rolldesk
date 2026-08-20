// Tests for the browser-notification routing. src/pushTargets.js is pure, so the
// question "who gets interrupted, and for what" is answered without a database
// and without a browser.
//
// This is the file to read when someone asks why they are (or are not) getting a
// notification: the matrix is PUSH_EVENT_ROLES and the three rules below it —
// never the actor, never outside project scope, an absent preference means the
// role default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PUSH_EVENT_ROLES, PUSH_EVENTS, isPushEvent, defaultEventsForRole, wantsEvent,
  inProjectScope, selectPushUsers, notificationPayload,
} from '../src/pushTargets.js';

const rm = (over = {}) => ({ id: 1, email: 'rm@dxc.test', role: 'rm', projects: [], ...over });
const dep = (over = {}) => ({ id: 2, email: 'dep@dxc.test', role: 'installer', projects: ['pik'], ...over });
const tester = (over = {}) => ({ id: 3, email: 'test@dxc.test', role: 'tester', projects: ['pik'], ...over });
const admin = (over = {}) => ({ id: 4, email: 'adm@dxc.test', role: 'admin', projects: [], ...over });
// The project manager, who clears a release for deployment. Scoped to their own
// projects, like the deployer and the tester.
const pm = (over = {}) => ({ id: 6, email: 'pm@dxc.test', role: 'pm', projects: ['pik'], ...over });
const client = (over = {}) => ({ id: 5, email: 'c@pwpw.test', role: 'client', projects: ['pik'], clientKey: 'pwpw', ...over });

const ALL = [rm(), dep(), tester(), admin(), client()];
const emails = (list) => list.map((u) => u.email).sort();

// ---- the matrix ------------------------------------------------------------

test('the two events the team asked for reach the roles that act on them', () => {
  // A handed-over package is the *project manager's* cue: until they clear the
  // release nothing can be planned from it, so telling the release manager first
  // was telling them about work they were not yet allowed to do.
  assert.deepEqual(
    emails(selectPushUsers({ eventKey: 'packageReady', projectKey: 'pik', users: ALL.concat([pm()]) })),
    ['adm@dxc.test', 'pm@dxc.test']
  );
  // The clearance is what the planners are waiting for.
  assert.deepEqual(
    emails(selectPushUsers({ eventKey: 'packageApproved', projectKey: 'pik', users: ALL.concat([pm()]) })),
    ['adm@dxc.test', 'dep@dxc.test', 'rm@dxc.test']
  );
  // A prepared schedule is the deployer's cue that work is coming.
  assert.deepEqual(
    emails(selectPushUsers({ eventKey: 'created', projectKey: 'pik', users: ALL })),
    ['adm@dxc.test', 'dep@dxc.test']
  );
});

test('a date change reaches both the planner and the person travelling', () => {
  // The most expensive one to miss: without it someone drives to a site on the
  // wrong day.
  assert.deepEqual(
    emails(selectPushUsers({ eventKey: 'scheduleChanged', projectKey: 'pik', users: ALL })),
    ['adm@dxc.test', 'dep@dxc.test', 'rm@dxc.test']
  );
});

test('a failure reaches the release manager and the tester, not the deployer', () => {
  // The deployer reported it; they do not need telling.
  assert.deepEqual(
    emails(selectPushUsers({ eventKey: 'failure', projectKey: 'pik', users: ALL })),
    ['adm@dxc.test', 'rm@dxc.test', 'test@dxc.test']
  );
});

test('a client decision reaches only the release manager, who is blocked by it', () => {
  assert.deepEqual(
    emails(selectPushUsers({ eventKey: 'decision', projectKey: 'pik', users: ALL })),
    ['adm@dxc.test', 'rm@dxc.test']
  );
});

test('client accounts are never pushed to, for any event', () => {
  for (const eventKey of PUSH_EVENTS) {
    const got = selectPushUsers({ eventKey, projectKey: 'pik', users: [client()] });
    assert.deepEqual(got, [], `${eventKey} reached a client account`);
  }
  assert.equal(inProjectScope(client(), 'pik'), false);
  for (const roles of Object.values(PUSH_EVENT_ROLES)) {
    assert.ok(!roles.includes('client'), 'client appears in the matrix');
  }
});

test('the noisy events are not pushable at all', () => {
  // A daily report per rollout, and a comment on one, would train people to block
  // notifications for the whole site. They stay on webhooks and e-mail.
  for (const key of ['dayReport', 'comment', 'completed', 'started', 'correction', 'clientComment', 'approval']) {
    assert.equal(isPushEvent(key), false, `${key} should not be pushable`);
    assert.deepEqual(selectPushUsers({ eventKey: key, projectKey: 'pik', users: ALL }), []);
  }
  // Nor an event nobody has heard of.
  assert.equal(isPushEvent('somethingElse'), false);
  assert.equal(isPushEvent(''), false);
  assert.equal(isPushEvent(undefined), false);
});

// ---- never the actor -------------------------------------------------------

test('the person who caused the event is not told about their own action', () => {
  // Otherwise the release manager who marks a package ready gets a popup
  // announcing it to themselves — which is how a new channel loses its audience
  // in the first five minutes.
  const got = selectPushUsers({
    eventKey: 'packageReady', projectKey: 'pik', users: ALL, actorEmail: 'rm@dxc.test',
  });
  assert.deepEqual(emails(got), ['adm@dxc.test']);
  // Matched case-insensitively — the address is typed in one place and stored in another.
  assert.deepEqual(
    emails(selectPushUsers({ eventKey: 'packageReady', projectKey: 'pik', users: ALL, actorEmail: 'RM@DXC.TEST' })),
    ['adm@dxc.test']
  );
});

// ---- project scope ---------------------------------------------------------

test('a deployer only hears about the projects they were granted', () => {
  const outside = dep({ email: 'other@dxc.test', projects: ['word'] });
  const got = selectPushUsers({ eventKey: 'created', projectKey: 'pik', users: [dep(), outside] });
  assert.deepEqual(emails(got), ['dep@dxc.test']);
});

test('release managers and admins are unscoped, like everywhere else', () => {
  assert.equal(inProjectScope(rm(), 'anything'), true);
  assert.equal(inProjectScope(admin(), 'anything'), true);
  // A scoped role with no project list, or an event with no project, gets nothing
  // rather than everything — a push must not be the one path that leaks a project.
  assert.equal(inProjectScope(dep({ projects: [] }), 'pik'), false);
  assert.equal(inProjectScope(dep(), ''), false);
  assert.equal(inProjectScope(dep(), undefined), false);
});

test('an archived account is not notified', () => {
  const got = selectPushUsers({ eventKey: 'created', projectKey: 'pik', users: [dep({ archived: true })] });
  assert.deepEqual(got, []);
});

// ---- preferences -----------------------------------------------------------

test('an absent preference means the role default, not off', () => {
  // The same rule as the per-client webhook event map: a missing key read as "off"
  // is how a whole category of notification went quietly undelivered before.
  assert.equal(wantsEvent({}, 'pm', 'packageReady'), true);
  assert.equal(wantsEvent(undefined, 'pm', 'packageReady'), true);
  assert.equal(wantsEvent(null, 'installer', 'created'), true);
  // ...but the default is per role: a deployer is not the audience for a handover,
  // and the release manager now waits for the approval rather than the handover.
  assert.equal(wantsEvent({}, 'installer', 'packageReady'), false);
  assert.equal(wantsEvent({}, 'rm', 'packageReady'), false);
  assert.equal(wantsEvent({}, 'rm', 'packageApproved'), true);
  assert.equal(wantsEvent({}, 'tester', 'created'), false);
});

test('an explicit preference wins in both directions', () => {
  assert.equal(wantsEvent({ packageReady: false }, 'pm', 'packageReady'), false);
  // A deployer who wants to see handovers may opt in, even though it is not their default.
  assert.equal(wantsEvent({ packageReady: true }, 'installer', 'packageReady'), true);
  // Anything other than a real `true` is not an opt-in.
  for (const v of ['true', 1, {}, [], 'yes']) {
    assert.equal(wantsEvent({ packageReady: v }, 'installer', 'packageReady'), false, JSON.stringify(v));
  }
});

test('an opt-out is honoured in the selection, not only in the predicate', () => {
  const quiet = rm({ notifyPrefs: { packageReady: false } });
  assert.deepEqual(
    emails(selectPushUsers({ eventKey: 'packageReady', projectKey: 'pik', users: [quiet, admin()] })),
    ['adm@dxc.test']
  );
});

test('an opt-in cannot escape project scope', () => {
  // Preferences say what you want to hear about; scope says what you are allowed
  // to hear about. The second one wins.
  const eager = dep({ projects: ['word'], notifyPrefs: { created: true } });
  assert.deepEqual(selectPushUsers({ eventKey: 'created', projectKey: 'pik', users: [eager] }), []);
});

test('a client cannot opt in to anything', () => {
  const eager = client({ notifyPrefs: { packageReady: true, created: true, failure: true } });
  for (const eventKey of PUSH_EVENTS) {
    assert.deepEqual(selectPushUsers({ eventKey, projectKey: 'pik', users: [eager] }), [], eventKey);
  }
});

test('the role defaults are the matrix, read back', () => {
  assert.deepEqual(defaultEventsForRole('rm').sort(),
    ['decision', 'failure', 'packageApproved', 'paused', 'scheduleApproved', 'scheduleChanged']);
  assert.deepEqual(defaultEventsForRole('installer').sort(),
    ['assigned', 'created', 'packageApproved', 'paused', 'scheduleApproved', 'scheduleChanged']);
  // The project manager is interrupted by exactly one thing: a release waiting on
  // their decision. Everything else about that release is in the bell drawer.
  assert.deepEqual(defaultEventsForRole('pm').sort(), ['packageReady']);
  assert.deepEqual(defaultEventsForRole('tester').sort(), ['failure']);
  // An admin does everything, so they see everything a team role would.
  assert.deepEqual(defaultEventsForRole('admin').sort(), PUSH_EVENTS.slice().sort());
  assert.deepEqual(defaultEventsForRole('client'), []);
  assert.deepEqual(defaultEventsForRole('nonsense'), []);
  assert.deepEqual(defaultEventsForRole(undefined), []);
  // Case is not the caller's problem.
  assert.deepEqual(defaultEventsForRole('RM'), defaultEventsForRole('rm'));
});

// ---- payload ---------------------------------------------------------------

test('the payload keeps the first lines and stays within a notification', () => {
  const p = notificationPayload({
    eventKey: 'created',
    subject: 'RollDesk — Schedule created (Production)',
    text: 'DEP-2026-0007 — PWPW / PIK\nStart: 2026-08-25 20:00\n400 targets over 10 working days\nplus a fourth line nobody will read',
    url: 'https://rolldesk.dxcpoland.pl/#deployments/DEP-2026-0007',
    deploymentId: 'DEP-2026-0007',
  });
  assert.equal(p.title, 'RollDesk — Schedule created (Production)');
  assert.equal(p.body, 'DEP-2026-0007 — PWPW / PIK\nStart: 2026-08-25 20:00\n400 targets over 10 working days');
  assert.equal(p.url, 'https://rolldesk.dxcpoland.pl/#deployments/DEP-2026-0007');
  assert.equal(p.event, 'created');
  // One notification per record: three date changes on one rollout replace each
  // other rather than stacking three unread popups.
  assert.equal(p.tag, 'rolldesk:DEP-2026-0007');
});

test('the payload is bounded and never empty', () => {
  const p = notificationPayload({ subject: 'x'.repeat(500), text: 'y'.repeat(2000), eventKey: 'failure' });
  assert.equal(p.title.length, 120);
  assert.equal(p.body.length, 300);
  assert.equal(p.tag, 'rolldesk:failure');
  // A missing subject still produces something a browser can render.
  assert.equal(notificationPayload({}).title, 'RollDesk');
  assert.equal(notificationPayload({}).body, '');
  assert.equal(notificationPayload({}).tag, 'rolldesk:event');
  // Blank lines in the composed body do not eat the line budget.
  assert.equal(notificationPayload({ text: '\n\nDEP-1\n\nPWPW' }).body, 'DEP-1\nPWPW');
});

test('a package event tags by package when there is no deployment', () => {
  const p = notificationPayload({ eventKey: 'packageReady', packageId: 'PKG-2026-0004' });
  assert.equal(p.tag, 'rolldesk:PKG-2026-0004');
});
