// Moving a project under a different client — pure validation and the fan-out
// that move implies. No I/O lives here, so the rules are unit-testable without a
// database (the same split as ipAllowlist.js and releasePackage.js);
// routes/projects.js does the queries and calls into this.
//
// Why a project can move at all: the client a project is delivered for is not
// fixed for its lifetime. A delivery is taken over by another company, two
// clients merge, or the project was simply filed under the wrong client on the
// day it was created. Without this, the only way out was deleting the project and
// creating it again under the right client — which throws away every deployment
// ever recorded against it, and the deployment history is the point of the app.
//
// What a move does NOT change is the project's technical key. That key is what
// deployments, release packages, attachments and per-user project grants all
// point at, so rewriting it would mean a data migration across five tables to
// achieve exactly what changing the client does. The key of a moved project
// therefore keeps the prefix of the client it was created under; it is an opaque
// identifier, and the client shown everywhere comes from the project record.

export const CLIENT_KEY_MAX = 64;
export const CLIENT_NAME_MAX = 120;

const str = (v) => (v == null ? '' : String(v)).trim();

// The shape the Clients form produces (slugifyClientName in the UI): lowercase
// letters, digits and dashes. Only consulted when the stored client list cannot
// confirm the key — a key that IS in that list is accepted exactly as stored,
// whatever its shape, because the list is the definition of what a client is.
const KEY_RE = /^[a-z0-9][a-z0-9-]*$/;

// Validate a requested move. `clients` is the stored client collection
// (app_state 'clients'), or null/undefined on an instance that has never saved
// one. Returns { ok: true, data: { clientKey, clientName } } or
// { ok: false, error }.
export function normalizeClientMove(body, clients) {
  const b = body && typeof body === 'object' ? body : {};
  const clientKey = str(b.clientKey ?? b.client);
  if (!clientKey) return { ok: false, error: 'A client is required' };
  if (clientKey.length > CLIENT_KEY_MAX) {
    return { ok: false, error: `Client key too long (max ${CLIENT_KEY_MAX} characters)` };
  }

  const list = Array.isArray(clients) ? clients.filter((c) => c && typeof c === 'object') : [];
  const match = list.find((c) => str(c.key) === clientKey);
  if (match) {
    // The stored client is the source of truth for the display name: taking it
    // from the request would let two projects of one client disagree about what
    // that client is called, and the name is what every list groups by.
    return {
      ok: true,
      data: {
        clientKey,
        clientName: str(match.name).slice(0, CLIENT_NAME_MAX) || clientKey,
      },
    };
  }
  // A client list exists and the target is not in it — the caller is naming a
  // client nobody defined, which would leave the project unreachable in the
  // Clients view and its deployment notifications with nowhere to go.
  if (list.length) return { ok: false, error: 'Unknown client' };

  // No client collection stored yet. Rather than refuse the move outright (the
  // projects still have a client each — the collection is only saved when the
  // Clients view is used), accept the key in the shape the form would have made
  // and take the name from the request.
  if (!KEY_RE.test(clientKey)) return { ok: false, error: 'Invalid client key' };
  const clientName = str(b.clientName).slice(0, CLIENT_NAME_MAX);
  if (!clientName) return { ok: false, error: 'A client name is required' };
  return { ok: true, data: { clientKey, clientName } };
}

// Client accounts that must lose this project when it moves. A Client-role user
// belongs to one client, so a grant held by an account of any other client is no
// longer a grant to their own data — it is a window into someone else's, and the
// two are competitors as often as not. An account with no client on file is
// revoked too: it was given the project while the project belonged to the old
// client, and "we do not know whose account this is" is not a reason to keep it.
//
// Users are the serialized shape ({ role, projects, clientKey }). Returns the
// subset to strip, so the caller can both update them and report who lost access.
export function staleClientGrants(users, projectKey, clientKey) {
  const key = str(projectKey);
  if (!key) return [];
  const target = str(clientKey);
  return (Array.isArray(users) ? users : []).filter((u) => {
    if (!u || u.role !== 'client') return false;
    const granted = Array.isArray(u.projects) ? u.projects.map(String) : [];
    if (!granted.includes(key)) return false;
    return str(u.clientKey) !== target;
  });
}

// The granted project keys a client account may still read, given who owns each
// project. Defence in depth behind the revocation above: a grant added by hand,
// a half-applied move, or a project moved while the account was signed in must
// not become another client's data on screen.
//
// `projectClients` maps project key → owning client key (missing/blank entries
// mean "unknown owner"). Only a positive mismatch drops a key: a project whose
// client was never recorded keeps behaving as it did before this check existed.
export function visibleProjectKeys(granted, projectClients, clientKey) {
  const owner = (k) => {
    if (!projectClients) return '';
    return str(projectClients instanceof Map ? projectClients.get(k) : projectClients[k]);
  };
  const target = str(clientKey);
  const keys = (Array.isArray(granted) ? granted : []).map(String);
  // Without a client on the account there is nothing to compare against, so the
  // grant list stands as it always has.
  if (!target) return keys;
  return keys.filter((k) => {
    const own = owner(k);
    return !own || own === target;
  });
}
