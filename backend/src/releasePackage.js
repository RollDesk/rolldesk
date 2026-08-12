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
// to be spread over hundreds of entries. The deployer instructions moved here
// from the deployment and get the same allowance: on this instance they already
// run to 2.5 kB, and truncating an install instruction is worse than storing it.
const MAX_CHANGES = 20000;
const MAX_INSTRUCTIONS = 20000;

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
//   id         the work item as the test team files it in the work tracker. This
//              is the one value a tester types; the other two are looked up from
//              it (see tracker.js).
//   haloTicket the service-desk ticket that work item answers. It is what a
//              deployer needs on screen during the rollout, so it is stored next
//              to the work item id.
//   office     the office that reported that ticket, read from the ticket itself.
//              The schedule puts those targets first — the office waiting for the
//              fix should not be the last one to receive it. Nobody types it: an
//              office typed by hand matched a registered target only when the
//              spelling happened to agree.
// Every value is stored verbatim, never parsed or reformatted: a tracker holds
// whatever its users typed (the same field carries "0167265" and "PR-0167134"),
// the UI turns the ids into links through configured URL patterns, and a
// tracker's nomenclature is not ours to normalize.
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
  // `smProblem` is the tracker field's own name and was this field's name here
  // until it turned out to confuse everyone reading the UI — the value is a
  // service-desk ticket id, so that is what it is called now. Both spellings are
  // still accepted so a stored package (and an existing API caller) keeps working.
  const haloTicket = clamp(i.haloTicket ?? i.halo_ticket ?? i.smProblem ?? i.sm_problem, 100);
  // The office is looked up from the ticket rather than typed, but it still
  // arrives in the body — the browser sends back what the lookup filled in.
  const office = clamp(i.office, 200);
  if (haloTicket) out.haloTicket = haloTicket;
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
  // How to install this release. It used to be typed on the deployment, which
  // meant retyping it for every rollout of the same build — the instructions
  // describe the build, not the date it goes out, so they belong here. A
  // deployment shows them read-only from the package it was planned from.
  const instructions = clamp(b.instructions ?? b.installerNotes ?? b.installer_notes, MAX_INSTRUCTIONS);

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
    instructions: instructions || undefined,
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

// The two kinds of file a package carries. The changelog is what the client
// reads; the instructions are how the deployer installs the build. They are told
// apart by the attachments table's `kind` column rather than by a filename, so
// the visibility rule below cannot be defeated by naming a file cleverly.
export const FILE_KINDS = ['changelog', 'instructions'];
export function isInstructionKind(kind) {
  // Anything unrecognised counts as instructions: if we cannot tell what a file
  // is, the narrower audience is the safe answer.
  return str(kind) !== 'changelog';
}

// The kind an uploader asked for, as it will be stored. Only the two known
// values are accepted, so a typo (or a caller inventing `kind=internal`) cannot
// create a third visibility class that no rule covers. `type` is accepted as an
// alias because that is what a multipart form field is often called.
export function requestedFileKind(body) {
  const k = str((body && (body.kind || body.type)) || '').toLowerCase();
  return k === 'instructions' ? 'instructions' : 'changelog';
}

// Whether a stored attachment row is a deployer instruction rather than the
// client-facing changelog. Same question as isInstructionKind, asked of the row
// the database returned — kept as its own function so a route reads the column
// through the one rule instead of restating it.
export function isInstructionFile(row) {
  return isInstructionKind(row && row.kind);
}

// Which of a package's files a caller may see. The only reason to withhold one
// is that it is deployer material and the reader is a client on a project that
// does not share admin information — every other role gets the whole list. The
// route around this does the two lookups (is the caller a client, does the
// project share) and nothing else, so the rule itself is testable without a
// database and cannot drift from the one applied to the package payload.
export function visiblePackageFiles(files, { isClient, sharesAdminInfo } = {}) {
  const list = Array.isArray(files) ? files : [];
  if (!isClient || sharesAdminInfo) return list;
  return list.filter((f) => !isInstructionFile(f));
}

// Strip the deployer-facing half of a package before returning it to a client
// account whose project does not share admin information. Mirrors
// stripAdminInfoFromDeployment: the instructions moved from the deployment to the
// package, and the rule they were subject to has to move with them.
export function stripAdminInfoFromPackage(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Object.assign({}, obj);
  delete out.instructions;
  if (Array.isArray(out.files)) out.files = out.files.filter((f) => !isInstructionKind(f && f.kind));
  return out;
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
