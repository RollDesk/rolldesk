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

// A fixed issue: the tracker id as the test team writes it (HaloITSM
// nomenclature here — the id is stored verbatim, never parsed or reformatted,
// because the UI turns it into a link via a configured URL pattern) plus what
// changed. The description is what the client ends up reading, so it is kept
// even when empty-ish input is filtered out by the id check.
function normalizeIssue(i) {
  if (i == null) return null;
  // A bare string is accepted so a caller can send ["HALO-1234", …].
  if (typeof i === 'string') {
    const id = clamp(i, 100);
    return id ? { id, description: '' } : null;
  }
  if (typeof i !== 'object') return null;
  const id = clamp(i.id, 100);
  if (!id) return null;
  return { id, description: clamp(i.description, MAX_TEXT) };
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

  const status = PACKAGE_STATUSES.includes(str(b.status)) ? str(b.status) : 'draft';
  // 'ready' is what a release manager may pick, so it must not be claimable for
  // a package that does not yet say what it fixes.
  if (status === 'ready' && !issues.length) {
    return { ok: false, error: 'A package cannot be marked ready with no issues listed' };
  }

  const data = {
    apps,
    issues,
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
// the issue list is what a reader of the deployment wants, and retyping it by
// hand is how the two drift apart.
export function packageChangelogText(pkg) {
  const issues = (pkg && Array.isArray(pkg.issues)) ? pkg.issues : [];
  return issues
    .map((i) => (i.description ? `${i.id} — ${i.description}` : i.id))
    .join('\n');
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
