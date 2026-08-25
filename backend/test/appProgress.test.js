// Tests for the per-application install progress helpers. src/appProgress.js is
// pure, so the two rules that used to be wrong on the record are covered without
// a database:
//   * a rollout that installed some of its applications is 'partial', not a lie
//     in either direction;
//   * an application added to a running rollout starts from zero, rather than
//     inheriting the targets that were closed before it existed on the list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAppResults, statusFromAppResults, appJoinedAt, appCoverage,
  appsHaveMixedCoverage, failedAppsAt, APP_RESULT_STATUSES,
  statusFromServiceResults, serviceResultTally,
} from '../src/appProgress.js';

// ---- normalizeAppResults ---------------------------------------------------

test('a per-application result keeps the name, status and the failure reason', () => {
  const shaped = normalizeAppResults([
    { name: ' Kolektor ', status: 'installed' },
    { name: 'Portal', status: 'failed', reason: '  the server stopped answering  ', by: 'A. Deployer', date: '2026-08-19', time: '21:40' },
  ]);
  assert.equal(shaped.ok, true);
  assert.deepEqual(shaped.data, [
    { name: 'Kolektor', status: 'installed' },
    { name: 'Portal', status: 'failed', reason: 'the server stopped answering', by: 'A. Deployer', date: '2026-08-19', time: '21:40' },
  ]);
});

test('an entry with no name or an invented status is refused, not dropped', () => {
  // Dropping it would store a report saying something other than what the
  // deployer saved, which is the whole failure mode this module exists to end.
  assert.equal(normalizeAppResults([{ status: 'installed' }]).ok, false);
  assert.equal(normalizeAppResults([{ name: 'A', status: 'scheduled' }]).ok, false);
  assert.equal(normalizeAppResults([{ name: 'A' }]).ok, false);
  assert.equal(normalizeAppResults([{ name: 'A', status: 'INSTALLED' }]).ok, false);
  assert.equal(normalizeAppResults(['A']).ok, false);
  assert.equal(normalizeAppResults('nope').ok, false);
  assert.equal(normalizeAppResults(undefined).ok, false);
});

test('the same application cannot be reported twice in one list', () => {
  const shaped = normalizeAppResults([
    { name: 'Portal', status: 'installed' },
    { name: 'portal', status: 'failed' },
  ]);
  assert.equal(shaped.ok, false);
  assert.match(shaped.error, /Duplicate/);
});

test('an explicit null clears the list', () => {
  assert.deepEqual(normalizeAppResults(null), { ok: true, data: [] });
  assert.deepEqual(normalizeAppResults([]), { ok: true, data: [] });
});

test('the stored text is bounded so a hostile payload cannot fill the JSONB', () => {
  const shaped = normalizeAppResults([{ name: 'x'.repeat(500), status: 'failed', reason: 'y'.repeat(5000) }]);
  assert.equal(shaped.ok, true);
  assert.equal(shaped.data[0].name.length, 200);
  assert.equal(shaped.data[0].reason.length, 1000);
  const many = normalizeAppResults(
    Array.from({ length: 101 }, (_, i) => ({ name: 'a' + i, status: 'installed' }))
  );
  assert.equal(many.ok, false);
});

test('the two outcomes are the only ones an application can carry', () => {
  assert.deepEqual(APP_RESULT_STATUSES, ['installed', 'failed']);
});

// ---- the services of one application result ---------------------------------
// An application released as a set of containers is installed one container at a
// time, and the one that will not start is what the next deployer needs named.

test('a service result keeps its name, its version and why it failed', () => {
  const shaped = normalizeAppResults([{
    name: 'Portal e-Usług',
    status: 'failed',
    services: [
      { name: ' auth-service ', version: ' 2.7.0-dev.27504 ', status: 'installed' },
      { name: 'frontend', version: '2.6.0-dev.27503', status: 'failed', reason: '  the image is not in the registry  ' },
    ],
  }]);
  assert.equal(shaped.ok, true);
  assert.deepEqual(shaped.data[0].services, [
    { name: 'auth-service', version: '2.7.0-dev.27504', status: 'installed' },
    { name: 'frontend', version: '2.6.0-dev.27503', status: 'failed', reason: 'the image is not in the registry' },
  ]);
});

test('a service with no name or an invented status is refused, like an application', () => {
  const bad = (services) => normalizeAppResults([{ name: 'Portal', status: 'installed', services }]).ok;
  assert.equal(bad([{ status: 'installed' }]), false);
  assert.equal(bad([{ name: 'auth', status: 'scheduled' }]), false);
  assert.equal(bad([{ name: 'auth' }]), false);
  assert.equal(bad(['auth']), false);
  assert.equal(bad('auth'), false);
});

test('the same service cannot be reported twice for one application', () => {
  const shaped = normalizeAppResults([{
    name: 'Portal', status: 'installed',
    services: [{ name: 'auth', status: 'installed' }, { name: 'AUTH', status: 'installed' }],
  }]);
  assert.equal(shaped.ok, false);
  assert.match(shaped.error, /Duplicate service/);
});

test('an application cannot be called installed while one of its services failed', () => {
  // Two answers to one question. Correcting it silently would store a report the
  // deployer did not save, which is what the whole module refuses to do.
  const claimed = normalizeAppResults([{
    name: 'Portal', status: 'installed',
    services: [{ name: 'auth', status: 'installed' }, { name: 'frontend', status: 'failed' }],
  }]);
  assert.equal(claimed.ok, false);
  assert.match(claimed.error, /services/);
  // Nor failed while every one of them went in.
  const denied = normalizeAppResults([{
    name: 'Portal', status: 'failed',
    services: [{ name: 'auth', status: 'installed' }],
  }]);
  assert.equal(denied.ok, false);
  // The honest pair: the set is not in, and the record says which part of it is.
  const partly = normalizeAppResults([{
    name: 'Portal', status: 'failed',
    services: [{ name: 'auth', status: 'installed' }, { name: 'frontend', status: 'failed' }],
  }]);
  assert.equal(partly.ok, true);
});

test('an absent or empty service list leaves the application result untouched', () => {
  // The ordinary single-artefact application, and the same application reported
  // before anybody ticked its services.
  const none = normalizeAppResults([{ name: 'Kolektor', status: 'installed' }]);
  assert.equal(none.ok, true);
  assert.equal('services' in none.data[0], false);
  const empty = normalizeAppResults([{ name: 'Kolektor', status: 'failed', services: [] }]);
  assert.equal(empty.ok, true);
  assert.equal('services' in empty.data[0], false);
});

test('the service list is bounded the way the package it comes from is', () => {
  const many = normalizeAppResults([{
    name: 'Portal', status: 'installed',
    services: Array.from({ length: 201 }, (_, i) => ({ name: 's' + i, status: 'installed' })),
  }]);
  assert.equal(many.ok, false);
  assert.match(many.error, /max 200/);
  const long = normalizeAppResults([{
    name: 'Portal', status: 'failed',
    services: [{ name: 'x'.repeat(500), version: 'v'.repeat(500), status: 'failed', reason: 'y'.repeat(5000) }],
  }]);
  assert.equal(long.ok, true);
  assert.equal(long.data[0].services[0].name.length, 200);
  assert.equal(long.data[0].services[0].version.length, 100);
  assert.equal(long.data[0].services[0].reason.length, 1000);
});

test('the services imply the application outcome: all, none, or fourteen of eighteen', () => {
  const svc = (installed, failed) => [
    ...Array.from({ length: installed }, (_, i) => ({ name: 'ok' + i, status: 'installed' })),
    ...Array.from({ length: failed }, (_, i) => ({ name: 'no' + i, status: 'failed' })),
  ];
  assert.equal(statusFromServiceResults(svc(18, 0)), 'installed');
  assert.equal(statusFromServiceResults(svc(0, 18)), 'failed');
  assert.equal(statusFromServiceResults(svc(14, 4)), 'partial');
  // Nothing reported on: the caller keeps whatever the application itself says.
  assert.equal(statusFromServiceResults([]), null);
  assert.equal(statusFromServiceResults(null), null);
  assert.equal(statusFromServiceResults(undefined), null);
  assert.equal(statusFromServiceResults('auth'), null);
  // A status this module does not know is not counted, so it cannot turn a whole
  // set partial by itself. Only a hand-written record can carry one.
  assert.equal(statusFromServiceResults([{ name: 'auth', status: 'scheduled' }]), null);
});

test('the tally is the figure a partial status is read with', () => {
  const entry = {
    name: 'Portal',
    services: [
      { name: 'auth', status: 'installed' },
      { name: 'frontend', status: 'failed' },
      { name: 'reports', status: 'installed' },
    ],
  };
  assert.deepEqual(serviceResultTally(entry), { installed: 2, failed: 1, total: 3 });
  assert.deepEqual(serviceResultTally({ name: 'Kolektor' }), { installed: 0, failed: 0, total: 0 });
  assert.deepEqual(serviceResultTally(null), { installed: 0, failed: 0, total: 0 });
});

test('one application whose services disagree makes the whole rollout partial', () => {
  // The reported case: a single application of eighteen containers, seventeen up.
  // With the application count alone this read as a flat failure, and the next
  // deployer was sent to install all eighteen again.
  const results = [{
    name: 'Portal e-Usług',
    status: 'failed',
    services: [{ name: 'auth', status: 'installed' }, { name: 'frontend', status: 'failed' }],
  }];
  assert.equal(statusFromAppResults(results, ['Portal e-Usług']), 'partial');
  // The whole set in, or none of it, still reads as the application says.
  assert.equal(statusFromAppResults(
    [{ name: 'Portal', status: 'installed', services: [{ name: 'auth', status: 'installed' }] }],
    ['Portal']
  ), 'installed');
  assert.equal(statusFromAppResults(
    [{ name: 'Portal', status: 'failed', services: [{ name: 'auth', status: 'failed' }] }],
    ['Portal']
  ), 'failed');
});

// ---- statusFromAppResults --------------------------------------------------

const NAMES = ['Kolektor', 'Portal', 'Rejestr', 'Raporty'];

test('all four installed is installed, all four failed is failed', () => {
  const all = (status) => NAMES.map((name) => ({ name, status }));
  assert.equal(statusFromAppResults(all('installed'), NAMES), 'installed');
  assert.equal(statusFromAppResults(all('failed'), NAMES), 'failed');
});

test('two of four installed is partial — the case the record could not express', () => {
  const results = [
    { name: 'Kolektor', status: 'installed' },
    { name: 'Portal', status: 'installed' },
    { name: 'Rejestr', status: 'failed', reason: 'the server stopped answering' },
    { name: 'Raporty', status: 'failed', reason: 'the server stopped answering' },
  ];
  assert.equal(statusFromAppResults(results, NAMES), 'partial');
});

test('an application nobody reported on leaves the rollout partial', () => {
  // An application added mid-rollout has no entry yet. Reading that as
  // "installed" is exactly the inherited-success bug, one level down.
  const results = NAMES.slice(0, 3).map((name) => ({ name, status: 'installed' }));
  assert.equal(statusFromAppResults(results, NAMES), 'partial');
});

test('nothing reported yields null, so the caller keeps scheduled', () => {
  assert.equal(statusFromAppResults([], NAMES), null);
  assert.equal(statusFromAppResults(null, NAMES), null);
  assert.equal(statusFromAppResults(undefined, undefined), null);
});

test('names are matched case-insensitively, as they are typed in two places', () => {
  assert.equal(statusFromAppResults([{ name: 'PORTAL', status: 'installed' }], ['portal']), 'installed');
});

test('with no application list the reported entries are judged alone', () => {
  assert.equal(statusFromAppResults([{ name: 'A', status: 'installed' }], []), 'installed');
  assert.equal(statusFromAppResults([{ name: 'A', status: 'failed' }, { name: 'B', status: 'installed' }], []), 'partial');
});

// ---- appJoinedAt / appCoverage ---------------------------------------------

test('an application on the list from the start covers the whole rollout', () => {
  const app = { name: 'Kolektor', version: '1.0.0' };
  assert.equal(appJoinedAt(app), null);
  assert.deepEqual(appCoverage(app, { counts: { installed: 120, scheduled: 280 }, totalLocations: 400 }), {
    planned: 400, installed: 120, joinedDay: 1, joinedAfter: 0,
  });
});

test('an application added on day four does not inherit the closed targets', () => {
  // This is the reported bug: 120 targets were finished before Raporty joined,
  // and the panel counted all 120 as having received it.
  const app = { name: 'Raporty', version: '2.1.0', since: { day: 4, date: '2026-08-19', installed: 120 } };
  assert.deepEqual(appJoinedAt(app), { day: 4, installed: 120, date: '2026-08-19' });
  assert.deepEqual(appCoverage(app, { counts: { installed: 120, scheduled: 280 }, totalLocations: 400 }), {
    planned: 280, installed: 0, joinedDay: 4, joinedAfter: 120,
  });
  // One more day reported: only what happened after it joined counts.
  assert.deepEqual(appCoverage(app, { counts: { installed: 160, scheduled: 240 }, totalLocations: 400 }), {
    planned: 280, installed: 40, joinedDay: 4, joinedAfter: 120,
  });
});

test('coverage never goes negative or over the planned count', () => {
  const app = { name: 'Raporty', since: { day: 4, installed: 120 } };
  // A correction that moved the total backwards below the join point.
  assert.equal(appCoverage(app, { counts: { installed: 80, scheduled: 320 }, totalLocations: 400 }).installed, 0);
  // A join point beyond the target count (a record edited after a re-scope).
  const late = { name: 'Raporty', since: { day: 9, installed: 900 } };
  assert.deepEqual(appCoverage(late, { counts: { installed: 400, scheduled: 0 }, totalLocations: 400 }), {
    planned: 0, installed: 0, joinedDay: 9, joinedAfter: 400,
  });
  // A malformed `since` degrades to "from the start" rather than throwing.
  assert.deepEqual(appJoinedAt({ since: {} }), { day: 1, installed: 0, date: undefined });
  assert.equal(appJoinedAt({ since: 'day 4' }), null);
  assert.equal(appJoinedAt(null), null);
});

test('mixed coverage is flagged as soon as one application joined late', () => {
  assert.equal(appsHaveMixedCoverage([{ name: 'A' }, { name: 'B' }]), false);
  assert.equal(appsHaveMixedCoverage([{ name: 'A' }, { name: 'B', since: { day: 3, installed: 40 } }]), true);
  assert.equal(appsHaveMixedCoverage(null), false);
});

test('coverage of a record with no counts is zero rather than NaN', () => {
  assert.deepEqual(appCoverage({ name: 'A' }, {}), { planned: 0, installed: 0, joinedDay: 1, joinedAfter: 0 });
  assert.deepEqual(appCoverage(null), { planned: 0, installed: 0, joinedDay: 1, joinedAfter: 0 });
});

// ---- failedAppsAt ----------------------------------------------------------

test('a failed target with no application detail means the whole install failed', () => {
  // What the entry meant when it was written, before failures were recorded per
  // application. Reading it as "nothing failed" would erase reported failures.
  assert.deepEqual(failedAppsAt({ location: 'WORD-7' }, NAMES), NAMES);
  assert.deepEqual(failedAppsAt(null, NAMES), NAMES);
});

test('a failed target names only the applications that failed there', () => {
  const entry = { location: 'WORD-7', failedApps: ['Rejestr', 'raporty'] };
  assert.deepEqual(failedAppsAt(entry, NAMES), ['Rejestr', 'Raporty']);
});

test('a stale application list falls back to the whole list', () => {
  // The rollout no longer carries "Archiwum", so the entry says nothing usable —
  // and "nothing failed at a target on the failed list" is not a reading.
  assert.deepEqual(failedAppsAt({ failedApps: ['Archiwum'] }, NAMES), NAMES);
  assert.deepEqual(failedAppsAt({ failedApps: [] }, NAMES), NAMES);
});
