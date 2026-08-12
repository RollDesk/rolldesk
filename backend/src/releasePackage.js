// Release-package domain logic — pure functions, no I/O.
//
// A package is the test team's handover: the application versions that were
// tested together, plus the issues those versions fix. Keeping the shaping and
// validation here (rather than inside the route) is what makes it testable
// without a database, the same split as ipAllowlist.js and deploymentPatch.js.

// Upper bounds exist so a malformed or hostile caller cannot store an unbounded
// blob in the JSONB column. They are far above any real package.
const MAX_APPS = 100;
const MAX_ISSUES = 500;
const MAX_TEXT = 2000;
// The description of what the release contains is now one block for the whole
// package instead of a line per issue, so it needs room for the text that used
// to be spread over hundreds of entries.
const MAX_CHANGES = 20000;

const str = (v) => (v == null ? '' : String(v)).trim();
const clamp = (v, n) => str(v).slice(0, n);

export const PACKAGE_STATUSES = ['draft', 'ready'];

// One application at a specific version. A package with no version is a package
// nobody can deploy, so both fields are required per entry.
function normalizeApp(a) {
  if (!a || typeof a !== 'object') return null;
  const name = clamp(a.name, 200);
  const version = clamp(a.version, 100);
  if (!name || !version) return null;
  return { name, version };
}

// A fixed issue is identifiers only — what changed is described once for the
// whole package (see `changes` below) rather than per issue:
//   id        the work item as the test team files it in Azure Boards
//   smProblem the "SM Problem" field of that work item, i.e. the HaloITSM
//             ticket the fix answers. It is what a deployer needs on screen
//             during the rollout, so it is stored next to the work item id.
//   office    the target that reported the ticket, when it is known. The
//             schedule puts those targets first — the office waiting for the
//             fix should not be the last one to receive it.
// Every value is stored verbatim, never parsed or reformatted: the UI turns the
// ids into links through configured URL patterns, and a tracker's nomenclature
// is not ours to normalize.
function normalizeIssue(i) {
  if (i == null) return null;
  // A bare string is accepted so a caller can send ["12345", …].
  if (typeof i === 'string') {
    const id = clamp(i, 100);
    return id ? { id } : null;
  }
  if (typeof i !== 'object') return null;
  const id = clamp(i.id, 100);
  if (!id) return null;
  const out = { id };
  const smProblem = clamp(i.smProblem ?? i.sm_problem, 100);
  const office = clamp(i.office, 200);
  if (smProblem) out.smProblem = smProblem;
  if (office) out.office = office;
  return out;
}

// Validate and shape an incoming package body. Returns {ok, data} or
// {ok:false, error} — the route turns the error into a 422.
export function normalizePackage(body, { id, createdBy } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const projectKey = clamp(b.projectKey ?? b.project_key, 200);
  if (!projectKey) return { ok: false, error: 'Required field: projectKey' };

  const rawApps = Array.isArray(b.apps) ? b.apps : [];
  if (rawApps.length > MAX_APPS) return { ok: false, error: `Too many applications (max ${MAX_APPS})` };
  const apps = rawApps.map(normalizeApp).filter(Boolean);
  if (!apps.length) {
    return { ok: false, error: 'A package needs at least one application with a version' };
  }

  const rawIssues = Array.isArray(b.issues) ? b.issues : [];
  if (rawIssues.length > MAX_ISSUES) return { ok: false, error: `Too many issues (max ${MAX_ISSUES})` };
  const issues = rawIssues.map(normalizeIssue).filter(Boolean);

  const changes = clamp(b.changes, MAX_CHANGES);

  const status = PACKAGE_STATUSES.includes(str(b.status)) ? str(b.status) : 'draft';
  // 'ready' is what a release manager may pick, so it must not be claimable for
  // a package that does not yet say what it fixes. Both halves are required:
  // the ids the deployer works from, and the description the client is sent as
  // the deployment's changelog.
  if (status === 'ready' && !issues.length) {
    return { ok: false, error: 'A package cannot be marked ready with no issues listed' };
  }
  if (status === 'ready' && !changes) {
    return { ok: false, error: 'A package cannot be marked ready without describing its changes' };
  }

  const data = {
    apps,
    issues,
    // What the release changes, written once for the package. This is the text
    // the client reads, so it is kept whole rather than reassembled from the
    // issue list.
    changes: changes || undefined,
    notes: clamp(b.notes, MAX_TEXT) || undefined,
    testedBy: clamp(b.testedBy, 200) || undefined,
  };

  return {
    ok: true,
    data: {
      id: id || clamp(b.id, 100) || null,
      projectKey,
      name: clamp(b.name, 300) || null,
      status,
      createdBy: clamp(createdBy ?? b.createdBy, 200) || null,
      data,
    },
  };
}

// DB row -> API object. Mirrors rowToObj in the other routes: the columns that
// were lifted out of the JSONB are put back on top of it.
export function packageRowToObj(r) {
  if (!r) return null;
  return Object.assign(
    {
      id: r.id,
      projectKey: r.project_key,
      name: r.name || undefined,
      status: r.status,
      createdBy: r.created_by || undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    },
    r.data && typeof r.data === 'object' ? r.data : {}
  );
}

// Changelog text derived from a package, used when a release manager picks one:
// the test team already wrote what the release changes, and retyping it by hand
// is how the two drift apart. The issue ids are listed underneath because the
// changelog also travels outside the app (the .txt export, the client e-mail),
// where the rendered issue table is not there to carry them.
export function packageChangelogText(pkg) {
  const changes = (pkg && typeof pkg.changes === 'string') ? pkg.changes.trim() : '';
  const ids = packageIssueIds(pkg);
  const idLine = ids.length ? ids.join(', ') : '';
  return [changes, idLine].filter(Boolean).join('\n\n');
}

// The tracker ids of the issues in a package, in the order the test team listed
// them.
export function packageIssueIds(pkg) {
  const issues = (pkg && Array.isArray(pkg.issues)) ? pkg.issues : [];
  return issues.map((i) => (i && i.id ? String(i.id) : '')).filter(Boolean);
}

// The offices that reported the tickets in a package (the "SM Problem" work
// items name them), deduplicated, in the order they appear on the issue list.
export function packageReportingOffices(pkg) {
  const issues = (pkg && Array.isArray(pkg.issues)) ? pkg.issues : [];
  const seen = new Set();
  const out = [];
  issues.forEach((i) => {
    const office = str(i && i.office).toLowerCase();
    if (!office || seen.has(office)) return;
    seen.add(office);
    out.push(str(i.office));
  });
  return out;
}

// Reorder production targets so the offices that reported the fixed tickets go
// first — they are the ones waiting for the release, and an alphabetical or
// as-entered order routinely put them on the last rollout day. Everything else
// keeps its relative order, so this only lifts the reporters to the front.
//
// Matching is case-insensitive against a target's code and its label, because
// the tester types whatever the ticket says (a code in one project, a full
// office name in another) and neither side is authoritative.
export function prioritizeReportingTargets(targets, offices) {
  const list = Array.isArray(targets) ? targets.slice() : [];
  const wanted = new Set((offices || []).map((o) => str(o).toLowerCase()).filter(Boolean));
  if (!wanted.size) return list;
  const isReporter = (t) => {
    if (!t) return false;
    const code = str(t.code).toLowerCase();
    const label = str(t.label).toLowerCase();
    return (!!code && wanted.has(code)) || (!!label && wanted.has(label));
  };
  const first = [], rest = [];
  list.forEach((t) => (isReporter(t) ? first : rest).push(t));
  return first.concat(rest);
}

// The next free id in the PKG-<year>-NNNN series, given the ids already stored.
// Sequential rather than random so the ids read in the order they were created,
// like the deployment ids.
export function nextPackageId(existingIds, year) {
  const prefix = `PKG-${year}-`;
  let max = 0;
  (existingIds || []).forEach((raw) => {
    const s = String(raw || '');
    if (!s.startsWith(prefix)) return;
    const n = parseInt(s.slice(prefix.length), 10);
    if (Number.isFinite(n) && n > max) max = n;
  });
  return prefix + String(max + 1).padStart(4, '0');
}
