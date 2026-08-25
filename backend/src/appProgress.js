// Per-application install progress — pure functions, no I/O.
//
// A deployment installs a list of applications, but until now the record only
// ever said whether *the deployment* succeeded. Two things broke because of
// that, and both are what this module exists to fix:
//
//   1. A server that stops answering halfway through leaves 2 of 4 applications
//      installed. There was no way to record that: the deployer had to call the
//      whole rollout either installed or failed, and the report then said
//      something that did not happen.
//   2. An application added to a rollout that is already running inherited the
//      completed history — the targets closed before it joined counted as having
//      received it. The rollout backbone is per target, so "12 of 400 done" was
//      read as 12 done for every application on the list, including the one that
//      joined on day four.
//
// The shapes below are stored in the deployment's `data` JSONB (see
// routes/deployments.js), so adding them needed no migration:
//
//   appResults      per-application outcome of a single-target install
//                   [{ name, status:'installed'|'failed', reason?, by?, date?, time?,
//                      services?: [{ name, version?, status, reason? }] }]
//   apps[].since    where an application joined a running rollout
//                   { day, date, installed }  — absent means "from the start"
//   failedLocations[].failedApps
//                   which applications failed at that target; absent = all of them
//
// The frontend mirrors `statusFromAppResults` and `appCoverage` (single-file
// vanilla JS, no module loader), the same arrangement as
// prioritizeReportingTargets in releasePackage.js. Change behaviour here and
// there together — these tests are what pins the two to the same rules.

// Bounds so a malformed or hostile caller cannot store an unbounded blob. Far
// above any real deployment: MAX_APP_RESULTS matches releasePackage's MAX_APPS,
// MAX_SERVICE_RESULTS its MAX_SERVICES — an application cannot be reported on for
// more services than a package can carry.
const MAX_APP_RESULTS = 100;
const MAX_SERVICE_RESULTS = 200;
const MAX_REASON = 1000;

const str = (v) => (v == null ? '' : String(v)).trim();
const clamp = (v, n) => str(v).slice(0, n);
const key = (v) => str(v).toLowerCase();

// The outcomes one application can have on one install. 'scheduled' is not one
// of them: an application nobody has reported on simply has no entry.
export const APP_RESULT_STATUSES = ['installed', 'failed'];

// The outcome of one service of one application. An application released as a set
// of services (see releasePackage.js) is installed service by service, and a
// single container that will not start is the ordinary failure of such a release:
// seventeen come up, one does not. Recording only "Portal e-Usług failed" then
// sends the next deployer to redo all eighteen.
//
// Statuses are the application's two — a service is in or it is not. 'partial'
// exists one level up, on the application whose services disagree.
//
// The version is stored beside the name because it is what identifies what went
// in: a service inherits the release version unless it is pinned away from it, so
// the same service name means a different artefact on the next rollout.
function normalizeServiceResults(list, appName) {
  if (list == null) return null;
  if (!Array.isArray(list)) return { error: `Services of ${appName} must be an array` };
  if (list.length > MAX_SERVICE_RESULTS) {
    return { error: `Too many service results for ${appName} (max ${MAX_SERVICE_RESULTS})` };
  }
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: `Each service result of ${appName} must be an object` };
    }
    const name = clamp(raw.name, 200);
    if (!name) return { error: `Each service result of ${appName} needs a name` };
    if (seen.has(key(name))) return { error: `Duplicate service result for ${appName}: ${name}` };
    seen.add(key(name));
    const status = str(raw.status);
    if (!APP_RESULT_STATUSES.includes(status)) {
      return {
        error: `Invalid status for ${appName} / ${name} (expected ${APP_RESULT_STATUSES.join(' | ')})`,
      };
    }
    const entry = { name, status };
    const version = clamp(raw.version, 100);
    if (version) entry.version = version;
    // A per-service reason, for the one container that failed for its own reason
    // rather than because the whole target went down.
    const reason = clamp(raw.reason, MAX_REASON);
    if (reason) entry.reason = reason;
    out.push(entry);
  }
  return { data: out };
}

// The application-level outcome its services imply: null when none of them has
// been reported on, 'installed' when they all went in, 'failed' when none did,
// 'partial' when they disagree — fourteen of eighteen.
//
// A service carrying a status outside the two known ones is not counted rather
// than making the whole set partial: normalizeAppResults rejects such an entry on
// the way in, so one can only appear in a record written by hand.
export function statusFromServiceResults(services) {
  let installed = 0;
  let failed = 0;
  (Array.isArray(services) ? services : []).forEach((s) => {
    const status = str(s && s.status);
    if (status === 'installed') installed += 1;
    else if (status === 'failed') failed += 1;
  });
  if (!installed && !failed) return null;
  if (!failed) return 'installed';
  if (!installed) return 'failed';
  return 'partial';
}

// How many services of one application result went in. The figure a "partly
// installed" status is read with — "14/18" — where the application count would
// say "0/1" and explain nothing.
export function serviceResultTally(entry) {
  const list = Array.isArray(entry && entry.services) ? entry.services : [];
  let installed = 0;
  let failed = 0;
  list.forEach((s) => {
    const status = str(s && s.status);
    if (status === 'installed') installed += 1;
    else if (status === 'failed') failed += 1;
  });
  return { installed, failed, total: list.length };
}

// Validate and shape an `appResults` list as it arrives from the browser or an
// automation caller. Returns {ok, data} or {ok:false, error} — the PATCH route
// turns the error into a 422.
//
// An entry without a name, or with a status outside the two above, is rejected
// rather than dropped: a silently ignored entry means the deployer's report is
// stored as something other than what they saved. For the same reason an entry
// that contradicts its own services is rejected rather than quietly corrected:
// "installed" beside a service that failed is two answers to one question, and
// guessing which of them the caller meant is not this module's business.
export function normalizeAppResults(list) {
  if (list === null) return { ok: true, data: [] };
  if (!Array.isArray(list)) return { ok: false, error: 'appResults must be an array' };
  if (list.length > MAX_APP_RESULTS) {
    return { ok: false, error: `Too many application results (max ${MAX_APP_RESULTS})` };
  }
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'Each application result must be an object' };
    }
    const name = clamp(raw.name, 200);
    if (!name) return { ok: false, error: 'Each application result needs a name' };
    if (seen.has(key(name))) {
      return { ok: false, error: `Duplicate application result: ${name}` };
    }
    seen.add(key(name));
    const status = str(raw.status);
    if (!APP_RESULT_STATUSES.includes(status)) {
      return {
        ok: false,
        error: `Invalid status for ${name} (expected ${APP_RESULT_STATUSES.join(' | ')})`,
      };
    }
    const entry = { name, status };
    // Why it failed is the whole value of the entry for a failure, so it is kept
    // whole up to a generous bound rather than summarised.
    const reason = clamp(raw.reason, MAX_REASON);
    if (reason) entry.reason = reason;
    const by = clamp(raw.by, 200);
    if (by) entry.by = by;
    // Stamps are the human-readable strings the rest of the record uses (see
    // stamp.js); they are stored as given, not parsed.
    const date = clamp(raw.date, 20);
    const time = clamp(raw.time, 10);
    if (date) entry.date = date;
    if (time) entry.time = time;
    const services = normalizeServiceResults(raw.services, name);
    if (services && services.error) return { ok: false, error: services.error };
    if (services && services.data.length) {
      const implied = statusFromServiceResults(services.data);
      // "Installed" means every service of the set went in; anything less is not
      // installed, whatever the caller called it.
      if ((implied === 'installed') !== (status === 'installed')) {
        return {
          ok: false,
          error: `${name} is reported ${status} but its services are ${implied}`,
        };
      }
      entry.services = services.data;
    }
    out.push(entry);
  }
  return { ok: true, data: out };
}

// The deployment status implied by the per-application outcomes.
//
//   null        nothing reported yet — the caller keeps 'scheduled'
//   'installed' every application on the list is installed
//   'failed'    every application on the list failed
//   'partial'   anything in between, including "some applications not reported"
//
// The last case is the point of the whole exercise: a rollout where 2 of 4
// applications went in is neither installed nor failed, and calling it either
// puts a number in the report that nobody performed.
//
// An application whose services disagree makes the whole record partial on its
// own, even when it is the only application on it. A single-application rollout of
// eighteen containers where seventeen came up is the same fact as two of four
// applications — and with the application count alone it read as a flat failure,
// which sends the next deployer to install all eighteen again.
//
// Matching is case-insensitive because the application name is typed in the
// project's application list and read back from the deployment's own copy.
export function statusFromAppResults(results, appNames) {
  const names = (Array.isArray(appNames) ? appNames : []).map(key).filter(Boolean);
  const byName = new Map();
  (Array.isArray(results) ? results : []).forEach((r) => {
    const k = key(r && r.name);
    if (k) byName.set(k, r);
  });
  if (!byName.size) return null;
  // With no application list to compare against, judge the reported entries
  // alone — that is all the caller has told us about.
  const wanted = names.length ? names : [...byName.keys()];
  let installed = 0, failed = 0, missing = 0, mixed = 0;
  wanted.forEach((k) => {
    const entry = byName.get(k);
    const s = str(entry && entry.status);
    if (statusFromServiceResults(entry && entry.services) === 'partial') mixed += 1;
    if (s === 'installed') installed += 1;
    else if (s === 'failed') failed += 1;
    else missing += 1;
  });
  if (mixed) return 'partial';
  if (installed && !failed && !missing) return 'installed';
  if (failed && !installed && !missing) return 'failed';
  return 'partial';
}

// Where an application joined the rollout. Returns `{day, installed}` with
// `installed` being how many targets were already closed at that moment, or null
// for an application that has been on the list since the deployment was planned.
export function appJoinedAt(app) {
  const since = app && app.since;
  if (!since || typeof since !== 'object') return null;
  const day = Math.max(1, Math.floor(Number(since.day) || 1));
  const installed = Math.max(0, Math.floor(Number(since.installed) || 0));
  return { day, installed, date: clamp(since.date, 20) || undefined };
}

// How much of the rollout one application has actually had, and how much it is
// planned for. The rollout backbone stays per target — this only discounts the
// targets that were already closed before the application joined.
//
// `counts` is the deployment's {installed, scheduled} pair; `totalLocations` its
// target count. For a single-target deployment pass counts as
// {installed: status === 'installed' ? 1 : 0, scheduled: …} or use
// statusFromAppResults instead — this function answers the batch question.
export function appCoverage(app, { counts, totalLocations } = {}) {
  const total = Math.max(0, Math.floor(Number(totalLocations) || 0));
  const doneAll = Math.max(0, Math.floor(Number(counts && counts.installed) || 0));
  const joined = appJoinedAt(app);
  const from = joined ? Math.min(joined.installed, total) : 0;
  return {
    // Targets this application is planned for: everything except the ones that
    // were already finished when it joined.
    planned: Math.max(0, total - from),
    // Targets that received it. Never negative, and never more than planned —
    // a corrected count that moved backwards must not read as over-delivery.
    installed: Math.min(Math.max(0, doneAll - from), Math.max(0, total - from)),
    joinedDay: joined ? joined.day : 1,
    joinedAfter: from,
  };
}

// Whether the applications on a rollout have drifted apart — true as soon as one
// of them joined late, which is what makes a single "312/400" figure misleading.
export function appsHaveMixedCoverage(apps) {
  return (Array.isArray(apps) ? apps : []).some((a) => !!appJoinedAt(a));
}

// Which applications failed at one target. An entry written before failures were
// recorded per application says nothing about them, and the honest reading of
// that silence is "the whole install failed there" — that is what it meant when
// it was written.
export function failedAppsAt(entry, appNames) {
  const names = (Array.isArray(appNames) ? appNames : []).map((n) => str(n)).filter(Boolean);
  const listed = entry && Array.isArray(entry.failedApps) ? entry.failedApps : null;
  if (!listed) return names;
  const wanted = new Set(listed.map(key).filter(Boolean));
  const out = names.filter((n) => wanted.has(key(n)));
  // A list naming only applications this deployment does not carry is a stale
  // record, not "nothing failed": fall back to the whole list.
  return out.length ? out : names;
}
