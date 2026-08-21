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
// An application released as a set of services (see normalizeServices). Portal
// e-Usług ships nineteen of them; the bound is generous rather than tight because
// the next such application is not ours to predict.
const MAX_SERVICES = 200;
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

// The services one application is released as.
//
// Some applications are not a single artefact: „Portal e-Usług" is nineteen
// containers cut from one release, and the version that matters is per service —
// seventeen at 2.7.0-dev.27504 while the frontend is still on 2.6.0-dev.27503.
// One row per application could not carry that, and one *package row* per service
// is not the answer either: the rollout, the install report, the client's
// changelog and the deployer's worklist are all about the application, so
// nineteen rows would multiply every one of them.
//
// So the services hang off the application entry, and a service's version is the
// application's unless the entry says otherwise — `version` is stored only when it
// differs, which is how these releases are actually cut (one train version, a
// couple of stragglers) and what keeps „Portal e-Usług v2.7.0-dev.27504" true
// everywhere it is already printed. A service the release does not carry is simply
// not in the list: not every service goes out every time.
//
// Names are the identity, so they are deduplicated case-insensitively — the same
// service twice with two versions has no meaning a reader could act on.
function normalizeServices(raw) {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set();
  const out = [];
  for (const s of raw.slice(0, MAX_SERVICES)) {
    // A bare string is accepted so a caller can send ["auth-service", …] and let
    // every one of them inherit the application's version.
    const src = typeof s === 'string' ? { name: s } : s;
    if (!src || typeof src !== 'object') continue;
    const name = clamp(src.name, 200);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const version = clamp(src.version, 100);
    out.push(version ? { name, version } : { name });
  }
  return out.length ? out : undefined;
}

// One application at a specific version. A package with no version is a package
// nobody can deploy, so both fields are required per entry — and with services
// that version is also the default every service inherits.
function normalizeApp(a) {
  if (!a || typeof a !== 'object') return null;
  const name = clamp(a.name, 200);
  const version = clamp(a.version, 100);
  if (!name || !version) return null;
  const out = { name, version };
  const services = normalizeServices(a.services);
  if (services) out.services = services;
  // Where the build itself is. A deployer works from the version and then has to
  // find the file, which was a question asked over chat for every rollout — so the
  // address belongs on the package that names the version. Stored as typed: this
  // is a UNC share as often as it is a URL, so it is not parsed or validated
  // beyond a length limit, and the UI only makes it a link when it can be one.
  const url = clamp(a.url ?? a.packageUrl ?? a.package_url, 1000);
  if (url) out.url = url;
  return out;
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
  // What the work item is called. Read from the tracker, not typed, and stored so
  // the list still says what each id is once the editor is closed — a column of
  // bare numbers tells a reader nothing about what the release fixes, and the
  // alternative is a lookup per row on every page that shows the list.
  const title = clamp(i.title, 300);
  // Where the work item stood when it was added to the package. Stored for the
  // same reason as the title: reopening the editor must show what the lookup
  // found, not an empty column until someone presses the refresh button. It is a
  // snapshot, not a live value — the tracker stays the source of truth, which is
  // why the id remains a link.
  const state = clamp(i.state, 60);
  if (haloTicket) out.haloTicket = haloTicket;
  if (office) out.office = office;
  if (title) out.title = title;
  if (state) out.state = state;
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
  // a package that does not say what it changes — that text is sent to the client
  // as the deployment's changelog. The issue list is not required: a release can
  // carry work that no tracker item was filed for, and the description covers it.
  if (status === 'ready' && !changes) {
    return { ok: false, error: 'A package cannot be marked ready without describing its changes' };
  }

  const data = {
    apps,
    issues,
    // A release that is only ever going to a test environment. Some changes are
    // verified on the test instance and never promoted, and the process around
    // that is a different one: the test team tells the operating team directly
    // and nobody is asked to plan, approve or escalate a production rollout that
    // will not happen. Without somewhere to say so, every such package looked
    // like a production release in the making and the extra step had to be
    // cancelled by hand, over mail, once per package.
    //
    // It lives on the package rather than on the deployment because it is a
    // property of what was tested, decided by the people who tested it — the
    // release manager planning the rollout is the reader, not the author. The
    // deployment form starts from it (test-only path preselected) and a rollout
    // still carries its own path, so a package marked this way cannot be
    // scheduled to production without someone overriding it deliberately.
    testOnly: b.testOnly === true || str(b.testOnly) === 'true' ? true : undefined,
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

// ---- Approval for deployment ------------------------------------------------
//
// A package handed over by the test team is not yet something to plan a rollout
// from: the project manager decides whether this release goes out at all. That
// decision existed in the process and nowhere in RollDesk, so a release manager
// planned rollouts from packages nobody had cleared, and the clearing itself
// happened in a mail thread or at a stand-up.
//
// It is a flag on the package rather than a third status, for the same reason the
// business acceptance of an estimate is not a status: `draft`/`ready` is the test
// team's own path (is the build finished), while this is a decision taken next to
// it by somebody else. Two readable states beat one column meaning two things.
const MAX_APPROVAL_COMMENT = 2000;

// The comment is the PM's answer, not a second description of the release: „only
// after the maintenance window", „skip office X". Optional, and kept whole.
export function makeApproval({ by, comment, at } = {}) {
  return {
    by: clamp(by, 200) || null,
    at: str(at) || new Date().toISOString(),
    comment: clamp(comment, MAX_APPROVAL_COMMENT) || undefined,
  };
}

// Tolerant read of the stored flag: anything unusable counts as not approved,
// because the one thing this must never do is wave through a package on a
// malformed value.
export function normalizeApproval(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const at = str(raw.at);
  if (!at) return null;
  return {
    by: clamp(raw.by, 200) || null,
    at,
    comment: clamp(raw.comment, MAX_APPROVAL_COMMENT) || undefined,
    // Set by the migration on packages that were already handed over when the
    // gate was introduced. They keep working — a release waiting on a rollout on
    // the day of an upgrade must not become unusable — and the UI says why the
    // record names no approver.
    legacy: raw.legacy === true ? true : undefined,
  };
}

// The approval on a package, whether given the API object or its `data` blob.
export function packageApproval(pkg) {
  const p = pkg && typeof pkg === 'object' ? pkg : {};
  const raw = p.approval !== undefined ? p.approval : (p.data && p.data.approval);
  return normalizeApproval(raw);
}

// Whether a rollout may be planned from this package. Both halves are needed: the
// test team says the build is finished, the project manager says it may go out.
export function isPackageApproved(pkg) {
  const p = pkg && typeof pkg === 'object' ? pkg : {};
  return str(p.status) === 'ready' && !!packageApproval(p);
}

// Why a package cannot be picked for a deployment, as a key the UI turns into a
// sentence. A reason rather than a silent omission: a package missing from the
// picker with no explanation is what sends somebody hunting through the list.
export function packageBlockReason(pkg) {
  const p = pkg && typeof pkg === 'object' ? pkg : {};
  if (str(p.status) !== 'ready') return 'draft';
  if (!packageApproval(p)) return 'awaiting-approval';
  return '';
}

// Whether an approval survives an edit to the package.
//
// It survives a correction to the prose — the description, the notes, the
// instructions, the issue list — because none of that changes what would be
// installed. It does not survive a change to the applications, their versions,
// the test-only flag or the status: the project manager cleared a specific build,
// and silently carrying their approval over to a different one would make the gate
// decorative. Re-approval is then asked for, which is the honest outcome.
export function approvalSurvivesEdit(prevData, nextData) {
  const a = prevData && typeof prevData === 'object' ? prevData : {};
  const b = nextData && typeof nextData === 'object' ? nextData : {};
  // The services are part of the build, not a detail of it: dropping one from the
  // release, adding one, or pinning one to a version of its own all change what
  // would be installed, so they belong in the fingerprint next to the version.
  const svc = (x) => (Array.isArray(x && x.services) ? x.services : [])
    .map((s) => `${str(s && s.name).toLowerCase()}@${str(s && s.version)}`)
    .sort()
    .join(',');
  const fingerprint = (d) => JSON.stringify({
    apps: (Array.isArray(d.apps) ? d.apps : [])
      .map((x) => `${str(x && x.name).toLowerCase()}@${str(x && x.version)}#${svc(x)}`)
      .sort(),
    testOnly: d.testOnly === true,
  });
  return fingerprint(a) === fingerprint(b);
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
    r.data && typeof r.data === 'object' ? r.data : {},
    // Normalised rather than passed through, so every reader (the packages table,
    // the schedule picker, a script) sees the same shape and the same answer to
    // „may this be deployed".
    {
      approval: normalizeApproval(r.data && r.data.approval) || undefined,
      approved: str(r.status) === 'ready' && !!normalizeApproval(r.data && r.data.approval),
    }
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
  // The build address goes with the instructions: it is where the installer is
  // fetched from during a rollout, which is deployer material and often a path on
  // an internal share. The versions themselves stay — a client is told what is
  // being released, just not how to obtain it.
  if (Array.isArray(out.apps)) {
    out.apps = out.apps.map((a) => {
      if (!a || typeof a !== 'object' || a.url === undefined) return a;
      const app = Object.assign({}, a);
      delete app.url;
      return app;
    });
  }
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
