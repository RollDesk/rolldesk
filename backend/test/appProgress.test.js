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
