// Tracker lookup — pure shaping/validation for the work-tracker and service-desk
// integrations. No I/O lives here, so the parsing of what those two APIs return
// is unit-testable without a network (the same split as ipAllowlist.js and
// releasePackage.js). trackerService.js does the fetching and calls into this.
//
// Why a lookup at all: a tester files a fix as a work item, and that work item
// carries the service-desk case it answers in a custom field. Typing both by hand
// meant typing the second one from memory, and a mistyped ticket id is invisible
// until the office that reported it asks why nothing was delivered. So the tester
// types the work item id and the app reads the rest.
//
// Nothing here is specific to one organisation, project or tenant. Which work
// tracker to query, which of its fields carries the ticket id, which service desk
// to ask about that ticket and which of *its* fields names the reporting office
// are all per-project settings (see normalizeTrackerSettings). The constants
// below are only the values the settings form starts from: they are what most
// installations use, not assumptions this code relies on. A project whose fields
// are named differently changes its settings and touches no code.

const str = (v) => (v == null ? '' : String(v)).trim();
const clamp = (v, n) => str(v).slice(0, n);

// The work-item field reference name the service-desk ticket is read from.
// Custom field reference names are tenant-specific: an organisation that renamed
// or re-created the field has a different one, and two projects in the same
// organisation need not agree.
export const DEFAULT_TICKET_FIELD = 'Custom.SMProblem';

// Path the service desk serves one ticket under; `{id}` is the ticket id. A
// template rather than a fixed path so an installation behind a gateway, or on an
// API version with a different route, is a setting and not a patch.
export const DEFAULT_TICKET_PATH = '/api/Tickets/{id}';

// Keys a service desk may name the reporting site/customer under, tried in order
// when a project does not name one explicitly. A project that names its own field
// (`officeField`) is answered from that field and this list is never consulted.
export const DEFAULT_OFFICE_KEYS = [
  'site_name', 'sitename', 'site', 'client_name', 'clientname', 'customer_name',
];

// A work item id is what the tester reads off the board — digits only.
// Everything else (a URL, "AB#41231", an empty box) is a typo we can catch
// before spending a request on it. The id is returned as a string because it is
// stored verbatim alongside ids from other trackers.
export function parseWorkItemId(raw) {
  const s = str(raw);
  if (!s) return null;
  if (/^\d{1,12}$/.test(s)) {
    const n = parseInt(s, 10);
    return n > 0 ? String(n) : null;
  }
  // Also accept what a copy out of Azure or a chat message looks like: a work
  // item URL (.../_workitems/edit/41231?…) or an "AB#41231" reference. A query
  // string is dropped first so api-version=7.0 cannot be read as the id.
  //
  // The separator before the digits must be a path or reference marker, not just
  // "any non-digit": trailing digits after a letter or a dash belong to a ticket
  // id from another tracker ("HALO-1234", "PR-0167134"), and silently reading
  // those as an Azure work item id would look up an unrelated work item.
  const withoutQuery = s.replace(/\?.*$/, '');
  const m = /(?:^|[/#])(\d{1,12})\/?$/.exec(withoutQuery);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n > 0 ? String(n) : null;
}

// The base URL an admin pastes out of the browser (a work-tracker organisation,
// a service-desk host), with any trailing slash dropped. https only, for either
// of them: both requests carry a credential, and over plain http that credential
// travels in the clear.
export function normalizeBaseUrl(raw) {
  const s = str(raw).replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https:\/\//i.test(s)) return '';
  return s;
}

// What we keep from a work item. The ticket id is the whole point of the call;
// the title and state come along because they are free and let the UI show the
// tester that they picked the work item they meant.
//
// The field the ticket id lives in is passed in, never assumed: it is a custom
// field, so its reference name belongs to the installation and not to us.
export function workItemFromAzure(json, { ticketField = DEFAULT_TICKET_FIELD } = {}) {
  if (!json || typeof json !== 'object') return null;
  const fields = json.fields && typeof json.fields === 'object' ? json.fields : {};
  const id = str(json.id);
  if (!id) return null;
  return {
    id,
    // Kept verbatim. Trackers hold whatever their users typed — the same field
    // can carry "0167265" in one work item and "PR-0167134" in the next — so any
    // normalisation here would corrupt one of the forms.
    ticket: clamp(fieldValue(fields, ticketField), 100),
    title: clamp(fields['System.Title'], 300) || undefined,
    state: clamp(fields['System.State'], 100) || undefined,
    type: clamp(fields['System.WorkItemType'], 100) || undefined,
  };
}

// Read a configured field name off a payload. The name may address a nested
// value ("site.name"), because a tracker or service desk is free to expand a
// related object rather than flatten it.
//
// Dots are ambiguous here and the ambiguity is not academic: a work-item field
// reference name contains them ("Custom.SMProblem") while a nested path uses
// them as separators. So a key that exists literally always wins, and only what
// is left over is descended into — longest literal prefix first, which resolves
// "Custom.Link.value" as the field "Custom.Link" then its "value".
function fieldValue(obj, path) {
  const p = str(path);
  if (!p || !obj || typeof obj !== 'object') return '';
  if (Object.prototype.hasOwnProperty.call(obj, p)) return obj[p];
  const dots = [];
  for (let i = 0; i < p.length; i++) if (p[i] === '.') dots.push(i);
  for (let i = dots.length - 1; i >= 0; i--) {
    const head = p.slice(0, dots[i]);
    if (Object.prototype.hasOwnProperty.call(obj, head)) {
      return fieldValue(obj[head], p.slice(dots[i] + 1));
    }
  }
  return '';
}

// The office that reported a service-desk ticket. The office drives the rollout
// order (reporters first), so it is worth reading; a project names the field it
// lives in, and when it does not we try the keys service desks commonly use
// rather than insisting on one shape.
export function officeFromTicket(json, { officeField = '' } = {}) {
  if (!json || typeof json !== 'object') return '';
  // A ticket endpoint returns either the ticket object or a collection holding it.
  const t = Array.isArray(json)
    ? json[0]
    : (Array.isArray(json.tickets) ? json.tickets[0] : json);
  if (!t || typeof t !== 'object') return '';
  const keys = str(officeField) ? [str(officeField)] : DEFAULT_OFFICE_KEYS;
  for (const key of keys) {
    const v = fieldValue(t, key);
    // The same key is an object in some installations and a plain name in
    // others, so unwrap before stringifying — String({}) would store
    // "[object Object]" as the office and quietly poison the rollout ordering.
    if (v && typeof v === 'object') {
      const nested = clamp(v.name ?? v.value ?? v.label, 200);
      if (nested) return nested;
      continue;
    }
    const flat = clamp(v, 200);
    if (flat) return flat;
  }
  return '';
}

// Per-project tracker settings, as an admin fills them in. The PAT/API key are
// handled separately (encrypted at rest, never returned to the browser), so this
// shapes only the non-secret half plus a flag saying whether a secret is set.
//
// Every value here is a setting precisely because none of it generalises: the
// organisation, the project name inside it, the custom field the ticket id sits
// in, the service-desk host, its ticket path and its office field all differ per
// installation.
// A link template has to say where the id goes. `{id}` is the ticket id exactly
// as the work item carried it; `{num}` is its digits only — a service desk that
// addresses a ticket by number cannot be handed the reference a tester reads.
export function hasIdPlaceholder(template) {
  const s = str(template);
  return s.includes('{id}') || s.includes('{num}');
}

// The digits of a ticket reference. Service desks show a ticket as a reference
// with a prefix and padding ("PR-0164935") but address it in a URL by its number
// alone (164935), so a link template needs a way to ask for the number. Leading
// zeros go with the prefix: they are display padding, not part of the id.
//
// Returns '' when there are no digits, which leaves the caller to fall back to
// the reference rather than linking to a truncated id.
export function ticketNumber(id) {
  const digits = str(id).replace(/\D+/g, '').replace(/^0+/, '');
  return digits;
}

export function normalizeTrackerSettings(body) {
  const b = body && typeof body === 'object' ? body : {};

  const azureOrgUrl = normalizeBaseUrl(b.azureOrgUrl ?? b.azure_org_url);
  if (str(b.azureOrgUrl ?? b.azure_org_url) && !azureOrgUrl) {
    return { ok: false, error: 'The work tracker organisation URL must start with https://' };
  }
  const serviceDeskUrl = normalizeBaseUrl(b.haloBaseUrl ?? b.halo_base_url);
  if (str(b.haloBaseUrl ?? b.halo_base_url) && !serviceDeskUrl) {
    return { ok: false, error: 'The service desk URL must start with https://' };
  }

  const ticketPath = clamp(b.ticketPath ?? b.ticket_path, 300) || DEFAULT_TICKET_PATH;
  // Without the placeholder the same ticket would be requested for every id, so
  // the lookup would answer confidently with the wrong office.
  if (!ticketPath.includes('{id}')) {
    return { ok: false, error: 'The ticket path must contain the {id} placeholder' };
  }
  if (!ticketPath.startsWith('/')) {
    return { ok: false, error: 'The ticket path must start with /' };
  }

  // The browser-facing link to one ticket. Optional: without it the ids are shown
  // as text, which is what they were before this setting existed.
  const ticketLinkPath = clamp(b.ticketLinkPath ?? b.ticket_link_path, 500);
  if (ticketLinkPath) {
    if (!hasIdPlaceholder(ticketLinkPath)) {
      return { ok: false, error: 'The ticket link must contain the {id} or {num} placeholder' };
    }
    if (!ticketLinkPath.startsWith('/')) {
      return { ok: false, error: 'The ticket link must start with /' };
    }
  }

  return {
    ok: true,
    data: {
      azureOrgUrl,
      azureProject: clamp(b.azureProject ?? b.azure_project, 200),
      // Blank falls back to the common reference name rather than disabling the
      // lookup: an installation that uses it should not have to retype it.
      ticketField: clamp(b.ticketField ?? b.ticket_field ?? b.smProblemField ?? b.sm_problem_field, 200)
        || DEFAULT_TICKET_FIELD,
      haloBaseUrl: serviceDeskUrl,
      ticketPath,
      // Blank means "try the usual keys" — see officeFromTicket.
      officeField: clamp(b.officeField ?? b.office_field, 200),
      // Where a reader is sent when they click a ticket id. Separate from
      // `ticketPath` (which the backend calls) because a service desk's own web
      // view is not its API route — HaloITSM serves one ticket from /ticket while
      // /tickets renders a list — and only the installation knows which.
      // `{num}` is the digits of the id, for a desk that addresses a ticket by
      // number rather than by the reference a tester reads. Blank = plain text.
      ticketLinkPath,
    },
  };
}

// Whether a project has enough configuration for the work item lookup to run.
// Missing configuration is not an error anywhere — the tester types the ticket
// id by hand, exactly as before the integration existed.
export function azureLookupConfigured(settings) {
  const s = settings || {};
  return !!(str(s.azureOrgUrl) && str(s.azureProject) && str(s.azurePat));
}

export function haloLookupConfigured(settings) {
  const s = settings || {};
  return !!(str(s.haloBaseUrl) && str(s.haloApiKey));
}

// The URL one ticket is read from, built from the configured template. Pure, so
// the templating is covered by a test instead of only over the network.
export function ticketUrl(settings, id) {
  const s = settings || {};
  const base = normalizeBaseUrl(s.haloBaseUrl);
  const ticketId = str(id);
  if (!base || !ticketId) return '';
  const path = str(s.ticketPath) || DEFAULT_TICKET_PATH;
  return base + path.replace('{id}', encodeURIComponent(ticketId));
}

// The two link patterns the UI turns issue ids into, derived from the project's
// tracker settings. `{id}` is left in place — the browser substitutes it, the
// same shape as the instance-wide ISSUE_TRACKER_URL/WORKITEM_URL environment
// settings, so the UI has one code path for both sources.
//
// The work item pattern is computed rather than configured: Azure DevOps serves
// a work item at a fixed route under the organisation and project that are
// already on file, so asking an admin to type a third URL that must agree with
// the first two only invites the two to disagree. The ticket link cannot be
// computed the same way — a service desk's web view is not derivable from its
// API host — so that one is the setting validated above.
//
// Neither is a secret and both are needed to render any package, so they are
// safe to hand to every reader.
export function trackerLinkPatterns(settings) {
  const s = settings || {};
  const org = normalizeBaseUrl(s.azureOrgUrl);
  const project = str(s.azureProject);
  const workItemUrl = (org && project)
    ? `${org}/${encodeURIComponent(project)}/_workitems/edit/{id}`
    : '';
  const deskBase = normalizeBaseUrl(s.haloBaseUrl);
  const linkPath = str(s.ticketLinkPath);
  const issueTrackerUrl = (deskBase && linkPath) ? deskBase + linkPath : '';
  return { workItemUrl, issueTrackerUrl };
}
