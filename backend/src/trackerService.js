// Tracker I/O — the thin fetching wrapper around the pure helpers in tracker.js.
//
// Two calls chained: read a work item to get the service-desk ticket id out of
// the configured field, then read that ticket to get the office that reported it.
// The office drives the rollout order (reporters first), so it is worth a second
// request; a failure there still returns the ticket id, which is the half the
// deployer needs on screen.
//
// The two APIs spoken here are Azure DevOps' work-item REST API and a
// Halo-style ticket API, but *what* they are asked is configuration: every URL,
// project name and field name comes from the project's settings, and nothing in
// this file names an organisation, a project or a tenant. Credentials are per
// project and stored in the database (an admin fills them in under the project)
// — see routes/projects.js for where they come from.
import { query } from './db.js';
import { encryptSecret, decryptSecret } from './sso.js';
import {
  parseWorkItemId, workItemFromAzure, officeFromTicket, ticketUrl,
  azureLookupConfigured, haloLookupConfigured, workItemLookupUrls, trackerProjects,
  workItemSearchUrl, workItemSearchBody, workItemsFromSearch, parseWorkItemFragment,
  DEFAULT_TICKET_FIELD, DEFAULT_TICKET_PATH,
} from './tracker.js';

// An external system must never hold up a request the tester is waiting on.
const TIMEOUT_MS = 12000;

const str = (v) => (v == null ? '' : String(v)).trim();

async function getJson(url, headers) {
  const res = await fetch(url, {
    headers: Object.assign({ accept: 'application/json' }, headers),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`${res.status} ${res.statusText}${body ? ' — ' + body.slice(0, 200) : ''}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Azure DevOps authenticates a PAT as HTTP basic with an empty username.
function azureAuthHeader(pat) {
  return { authorization: 'Basic ' + Buffer.from(':' + str(pat)).toString('base64') };
}

// The non-secret settings, with every configurable name resolved to either what
// the project set or the documented default. One place does this so the routes,
// the status endpoint and the lookup cannot disagree about what a blank field
// means.
function resolveSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    azureOrgUrl: str(r.azureOrgUrl),
    // The list, and the first entry under the old key: one product is split across
    // several tracker projects (see trackerProjects), and everything downstream
    // reads the list while anything still asking for one name gets the primary.
    azureProjects: trackerProjects(r),
    azureProject: trackerProjects(r)[0] || '',
    ticketField: str(r.ticketField) || str(r.smProblemField) || DEFAULT_TICKET_FIELD,
    haloBaseUrl: str(r.haloBaseUrl),
    ticketPath: str(r.ticketPath) || DEFAULT_TICKET_PATH,
    officeField: str(r.officeField),
  };
}

// The tracker settings stored on a project, with the secrets decrypted. Secrets
// live in the same JSONB as the rest of the project (encrypted, like the SSO
// client secrets) so adding them needed no schema change.
export async function projectTrackerSettings(projectKey) {
  if (!projectKey) return null;
  const { rows } = await query(`SELECT data->'tracker' AS tracker FROM projects WHERE key = $1`, [projectKey]);
  const raw = rows[0] && rows[0].tracker;
  if (!raw || typeof raw !== 'object') return null;
  const out = Object.assign(resolveSettings(raw), { azurePat: '', haloApiKey: '' });
  // A secret that cannot be decrypted (the encryption key changed) must not
  // take the whole project down — the lookup degrades to "not configured".
  for (const [enc, plain] of [['azurePatEnc', 'azurePat'], ['haloApiKeyEnc', 'haloApiKey']]) {
    if (!raw[enc]) continue;
    try {
      out[plain] = decryptSecret(raw[enc]);
    } catch (err) {
      console.warn(`[tracker] cannot decrypt ${enc} for project ${projectKey}: ${err.message}`);
    }
  }
  return out;
}

// Store the non-secret settings, encrypting each secret that was supplied and
// keeping the stored one when the field is left blank (the browser never gets a
// secret back, so a blank field means "unchanged", not "clear it").
export function trackerSettingsForStorage(settings, secrets, previous) {
  const prev = previous && typeof previous === 'object' ? previous : {};
  const out = Object.assign({}, settings);
  for (const [enc, key] of [['azurePatEnc', 'azurePat'], ['haloApiKeyEnc', 'haloApiKey']]) {
    const supplied = str(secrets && secrets[key]);
    if (supplied === '__clear__') continue;               // explicit removal
    if (supplied) out[enc] = encryptSecret(supplied);
    else if (prev[enc]) out[enc] = prev[enc];
  }
  return out;
}

// Which halves are usable, for the admin UI and the "why did nothing fill in"
// message. Never reports the secrets themselves.
export function trackerStatus(settings) {
  const r = resolveSettings(settings);
  return {
    // Named after what they enable rather than after a vendor: the first is the
    // work-item lookup, the second the ticket lookup that adds the office.
    workItems: azureLookupConfigured(settings),
    tickets: haloLookupConfigured(settings),
    // Both shapes: the admin form edits the list, older callers show one name.
    azureProjects: r.azureProjects,
    azureProject: r.azureProject,
    ticketField: r.ticketField,
    officeField: r.officeField,
  };
}

// Look up one work item. Returns {ok:true, issue} where issue is
// {id, ticket, office, title, state}, or {ok:false, reason, detail} — the route
// turns the reason into a message, and the tester can always type the values by
// hand instead.
export async function lookupWorkItem(projectKey, rawId) {
  const id = parseWorkItemId(rawId);
  if (!id) return { ok: false, reason: 'bad-id' };

  const settings = await projectTrackerSettings(projectKey);
  if (!azureLookupConfigured(settings)) return { ok: false, reason: 'work-items-not-configured' };

  // Tried in order: each tracker project the RollDesk project names, then the
  // organisation-wide route (see workItemLookupUrls).
  //
  // A 404 *and* a 401/403 both move on to the next URL. That is the whole point of
  // configuring several projects: a personal access token is commonly scoped to
  // some of an organisation's projects and not others, so the project that refuses
  // the request is not an answer about the item — the next one may hold it. Only
  // when every URL has refused is "unauthorized" reported, and a transport failure
  // (DNS, timeout, 5xx) still stops immediately: retrying that against another
  // path fails the same way and doubles the wait.
  const urls = workItemLookupUrls(settings, id);
  let json = null, denied = false, lastErr = null;
  for (const url of urls) {
    try {
      json = await getJson(url, azureAuthHeader(settings.azurePat));
      break;
    } catch (err) {
      lastErr = err;
      if (err.status === 404) continue;
      if (err.status === 401 || err.status === 403) { denied = true; continue; }
      console.warn(`[tracker] work item lookup of ${id} failed: ${err.message}`);
      return { ok: false, reason: 'work-items-unreachable', detail: err.message };
    }
  }
  if (!json) {
    // A refusal anywhere outranks "not found": the item may well exist behind the
    // project that would not answer, and telling the tester it does not exist would
    // send them looking for a work item they are reading on their screen.
    if (denied) return { ok: false, reason: 'work-items-unauthorized' };
    if (lastErr && lastErr.status !== 404) {
      return { ok: false, reason: 'work-items-unreachable', detail: lastErr.message };
    }
    return { ok: false, reason: 'work-item-not-found' };
  }

  const issue = workItemFromAzure(json, { ticketField: settings.ticketField });
  if (!issue) return { ok: false, reason: 'work-item-not-found' };
  // Answering from another tracker project is not an error — the fix is real and
  // the ids are the ones the deployer needs — but it is worth saying out loud:
  // either the project's `azureProject` setting is stale, or this release genuinely
  // carries work from a neighbouring backlog. Silence made a wrong setting look
  // like a working one.
  // Cross-project means "outside every project this RollDesk project names" — with
  // a list configured, an item from the second or third entry was looked for on
  // purpose and saying "found somewhere else" about it would be noise.
  const foundIn = str(issue.project);
  const configured = trackerProjects(settings).map((p) => p.toLowerCase());
  const crossProject = !!(foundIn && configured.length && !configured.includes(foundIn.toLowerCase()));

  // The office comes from the service-desk ticket, so it is only available when
  // the work item names a ticket and the service desk is configured. Neither is
  // required — an installation may run the work-item half alone.
  let office = '';
  if (issue.ticket && haloLookupConfigured(settings)) {
    office = await lookupTicketOffice(settings, issue.ticket);
  }
  return {
    ok: true,
    crossProject: crossProject || undefined,
    issue: Object.assign({}, issue, { office: office || undefined }),
  };
}

// Suggestions for a fragment of a work item id — what the tracker's own search box
// does, so the tester types four digits and picks the item instead of typing all of
// it and hoping.
//
// Best-effort throughout: the search service is a separate Azure DevOps service
// with its own permissions, and a PAT that can read work items is not guaranteed to
// be allowed to search them. Every failure is an empty list with a reason, never an
// error — the id lookup is the path that must keep working.
export async function searchWorkItems(projectKey, rawFragment) {
  const fragment = parseWorkItemFragment(rawFragment);
  if (!fragment) return { ok: false, reason: 'bad-id', items: [] };

  const settings = await projectTrackerSettings(projectKey);
  if (!azureLookupConfigured(settings)) return { ok: false, reason: 'work-items-not-configured', items: [] };
  const url = workItemSearchUrl(settings);
  // Not hosted Azure DevOps: there is no search host to ask. The id lookup still
  // answers, so this is a missing convenience rather than a fault.
  if (!url) return { ok: false, reason: 'search-not-available', items: [] };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: Object.assign(
        { accept: 'application/json', 'content-type': 'application/json' },
        azureAuthHeader(settings.azurePat)
      ),
      body: JSON.stringify(workItemSearchBody(fragment, settings)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const reason = (res.status === 401 || res.status === 403)
        ? 'work-items-unauthorized'
        : 'search-not-available';
      // Logged once per failure rather than swallowed: "no suggestions ever" with
      // nothing in the log is the failure mode this comment exists to prevent.
      console.warn(`[tracker] work item search for "${fragment}" answered ${res.status}`);
      return { ok: false, reason, items: [] };
    }
    const json = await res.json();
    // The search matches the fragment anywhere, including in a title, so an item
    // whose id does not start with what was typed is ranked below the ones that do —
    // the tester is typing a number, not searching prose.
    const items = workItemsFromSearch(json);
    const starts = items.filter((i) => i.id.startsWith(fragment));
    const rest = items.filter((i) => !i.id.startsWith(fragment));
    return { ok: true, items: starts.concat(rest) };
  } catch (err) {
    console.warn(`[tracker] work item search for "${fragment}" failed: ${err.message}`);
    return { ok: false, reason: 'work-items-unreachable', items: [] };
  }
}

// The reporting office for a service-desk ticket. Best-effort by design: a
// failure here costs the rollout ordering hint, not the lookup, so it warns and
// returns ''.
async function lookupTicketOffice(settings, ticketId) {
  const url = ticketUrl(settings, ticketId);
  if (!url) return '';
  try {
    const json = await getJson(url, { authorization: `Bearer ${settings.haloApiKey}` });
    return officeFromTicket(json, { officeField: settings.officeField });
  } catch (err) {
    console.warn(`[tracker] ticket lookup of ${ticketId} failed: ${err.message}`);
    return '';
  }
}
