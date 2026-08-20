// Tests for the tracker lookup shaping. src/tracker.js is pure, so the parsing
// of what a work tracker and a service desk return is covered without a network —
// the fetching lives in trackerService.js.
//
// The module is deliberately generic: which field carries the ticket id, which
// path serves a ticket and which field names the reporting office are settings.
// These tests therefore exercise a configured field at least as hard as the
// default one, so a tenant-shaped assumption creeping back in fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWorkItemId, normalizeBaseUrl, workItemFromAzure, officeFromTicket,
  normalizeTrackerSettings, azureLookupConfigured, haloLookupConfigured, ticketUrl,
  trackerLinkPatterns, ticketNumber, hasIdPlaceholder, workItemLookupUrls,
  trackerProjects, MAX_TRACKER_PROJECTS, parseWorkItemFragment, workItemSearchUrl,
  workItemSearchBody, workItemsFromSearch, SEARCH_TOP,
  DEFAULT_TICKET_FIELD, DEFAULT_TICKET_PATH, DEFAULT_OFFICE_KEYS,
} from '../src/tracker.js';

test('a work item id is digits, with padding tolerated', () => {
  assert.equal(parseWorkItemId('41231'), '41231');
  assert.equal(parseWorkItemId('  41231  '), '41231');
  // Leading zeros are the tester's typing, not a different work item.
  assert.equal(parseWorkItemId('0041231'), '41231');
});

// This is what a copy out of the tracker or a chat message actually looks like,
// and rejecting it would send the tester back to retyping the number by hand.
test('a pasted work item URL or AB# reference yields the id', () => {
  assert.equal(
    parseWorkItemId('https://dev.azure.com/Org/Proj/_workitems/edit/41231'),
    '41231'
  );
  assert.equal(parseWorkItemId('AB#41231'), '41231');
  assert.equal(parseWorkItemId('#41231'), '41231');
  assert.equal(parseWorkItemId('.../_workitems/edit/41231/'), '41231');
});

// A query string must not be mined for digits, or api-version=7.0 becomes the id.
test('a query string is not read as the id', () => {
  assert.equal(parseWorkItemId('.../_workitems/edit/41231?api-version=7.0'), '41231');
});

test('anything without a usable id is rejected rather than guessed', () => {
  for (const bad of ['', '   ', null, undefined, 'HALO-1234', 'abc', '0', '-5']) {
    assert.equal(parseWorkItemId(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('a base URL must be https, and loses its trailing slash', () => {
  assert.equal(normalizeBaseUrl('https://dev.azure.com/Org/'), 'https://dev.azure.com/Org');
  assert.equal(normalizeBaseUrl('  https://dev.azure.com/Org  '), 'https://dev.azure.com/Org');
  // A credential would travel over the wire in the clear, so plain http is out.
  assert.equal(normalizeBaseUrl('http://dev.azure.com/Org'), '');
  assert.equal(normalizeBaseUrl('dev.azure.com/Org'), '');
  assert.equal(normalizeBaseUrl(''), '');
});

// The service-desk ticket is what the whole lookup exists for.
test('the work item yields the ticket id plus context', () => {
  const wi = workItemFromAzure({
    id: 81989,
    fields: {
      [DEFAULT_TICKET_FIELD]: '0167265',
      'System.Title': 'Wrong data in the driver component',
      'System.State': 'Resolved',
      'System.WorkItemType': 'Product Backlog Bug',
    },
  });
  assert.equal(wi.id, '81989');
  assert.equal(wi.ticket, '0167265');
  assert.equal(wi.title, 'Wrong data in the driver component');
  assert.equal(wi.state, 'Resolved');
  assert.equal(wi.type, 'Product Backlog Bug');
});

// A tracker holds whatever its users typed: the same field carries "0167265" in
// one work item and "PR-0167134" in the next, so normalising would corrupt one.
test('the ticket value is kept verbatim', () => {
  const bare = workItemFromAzure({ id: 1, fields: { [DEFAULT_TICKET_FIELD]: '0167265' } });
  assert.equal(bare.ticket, '0167265');
  const prefixed = workItemFromAzure({ id: 2, fields: { [DEFAULT_TICKET_FIELD]: ' PR-0167134 ' } });
  assert.equal(prefixed.ticket, 'PR-0167134');
});

// The field name belongs to the installation, so a project naming its own must be
// honoured and the default must not be consulted at all.
test('a configured field name replaces the default', () => {
  const wi = workItemFromAzure(
    { id: 3, fields: { 'Custom.OtherName': 'INC-9', [DEFAULT_TICKET_FIELD]: 'ignored' } },
    { ticketField: 'Custom.OtherName' }
  );
  assert.equal(wi.ticket, 'INC-9');
});

// Some trackers expand a related object instead of flattening it, so a dotted
// field name has to reach into it.
test('a dotted field name reads a nested value', () => {
  const wi = workItemFromAzure(
    { id: 4, fields: { 'Custom.Link': { value: 'REQ-7' } } },
    { ticketField: 'Custom.Link.value' }
  );
  assert.equal(wi.ticket, 'REQ-7');
  // A literal key containing dots (which is the usual case: "Custom.SMProblem")
  // must win over being split apart.
  const literal = workItemFromAzure(
    { id: 5, fields: { 'Custom.SMProblem': '42' } },
    { ticketField: 'Custom.SMProblem' }
  );
  assert.equal(literal.ticket, '42');
});

// A work item with the field empty is normal (not every fix answers a ticket),
// so it must shape cleanly rather than throw or look like a failed call.
test('a work item without a ticket still shapes', () => {
  const wi = workItemFromAzure({ id: 6, fields: { 'System.Title': 'Refactor' } });
  assert.equal(wi.ticket, '');
  assert.equal(wi.title, 'Refactor');
  assert.equal(workItemFromAzure(null), null);
  assert.equal(workItemFromAzure({ fields: {} }), null); // no id
});

// With no configured field we try the keys service desks commonly use, because
// the office is what the rollout order is built from.
test('the reporting office is read from whichever common key carries it', () => {
  assert.equal(officeFromTicket({ site_name: 'Tax office Kraków' }), 'Tax office Kraków');
  assert.equal(officeFromTicket({ client_name: 'Tax office Gdańsk' }), 'Tax office Gdańsk');
  assert.equal(officeFromTicket({ site: { name: 'Tax office Poznań' } }), 'Tax office Poznań');
  // A single-element collection is the other shape a ticket endpoint returns.
  assert.equal(officeFromTicket([{ site_name: 'Tax office Łódź' }]), 'Tax office Łódź');
  assert.equal(officeFromTicket({ tickets: [{ site_name: 'Tax office Lublin' }] }), 'Tax office Lublin');
  // The fallback list is a documented default, not a hidden one.
  assert.ok(DEFAULT_OFFICE_KEYS.includes('site_name'));
});

test('a configured office field wins over the common keys', () => {
  const ticket = { site_name: 'Wrong', organisation: { name: 'Tax office Opole' } };
  assert.equal(officeFromTicket(ticket, { officeField: 'organisation.name' }), 'Tax office Opole');
  // And when the configured field is empty we do not silently fall back to a
  // different field: the admin said where the office lives.
  assert.equal(officeFromTicket(ticket, { officeField: 'department' }), '');
});

test('a ticket naming no office yields an empty string, never a throw', () => {
  assert.equal(officeFromTicket({ id: 1 }), '');
  assert.equal(officeFromTicket({ site_name: '   ' }), '');
  assert.equal(officeFromTicket(null), '');
  assert.equal(officeFromTicket([]), '');
  assert.equal(officeFromTicket('nope'), '');
  // An object under the key with no usable name must not become "[object Object]".
  assert.equal(officeFromTicket({ site: { id: 7 } }), '');
});

test('tracker settings are shaped, and the names default', () => {
  const r = normalizeTrackerSettings({
    azureOrgUrl: 'https://dev.azure.com/Org/',
    azureProject: ' Proj ',
    haloBaseUrl: 'https://servicedesk.example.com/',
  });
  assert.equal(r.ok, true);
  assert.equal(r.data.azureOrgUrl, 'https://dev.azure.com/Org');
  assert.equal(r.data.azureProject, 'Proj');
  assert.equal(r.data.haloBaseUrl, 'https://servicedesk.example.com');
  // Blank means "the usual name", not "disable the lookup".
  assert.equal(r.data.ticketField, DEFAULT_TICKET_FIELD);
  assert.equal(r.data.ticketPath, DEFAULT_TICKET_PATH);
  // Blank office field means "try the common keys".
  assert.equal(r.data.officeField, '');
});

// Settings written before the field names were configurable used this key.
test('the previous setting name is still accepted', () => {
  const r = normalizeTrackerSettings({ smProblemField: 'Custom.Legacy' });
  assert.equal(r.data.ticketField, 'Custom.Legacy');
});

// A silently dropped URL would look like a saved integration that never runs.
test('a non-https URL is refused rather than stored empty', () => {
  const a = normalizeTrackerSettings({ azureOrgUrl: 'http://dev.azure.com/Org' });
  assert.equal(a.ok, false);
  assert.match(a.error, /https/);
  const h = normalizeTrackerSettings({ haloBaseUrl: 'http://servicedesk.example.com' });
  assert.equal(h.ok, false);
  assert.match(h.error, /https/);
  // Omitting them entirely is fine — that is an unconfigured project.
  assert.equal(normalizeTrackerSettings({}).ok, true);
});

// Without {id} every id would request the same ticket, so the lookup would
// answer confidently with the wrong office.
test('a ticket path must be a rooted template containing {id}', () => {
  assert.equal(normalizeTrackerSettings({ ticketPath: '/api/Tickets' }).ok, false);
  assert.equal(normalizeTrackerSettings({ ticketPath: 'api/Tickets/{id}' }).ok, false);
  const r = normalizeTrackerSettings({ ticketPath: '/v2/incidents/{id}/detail' });
  assert.equal(r.ok, true);
  assert.equal(r.data.ticketPath, '/v2/incidents/{id}/detail');
});

// The link is what a reader clicks, so a template without a placeholder would
// send every reader to the same ticket — worse than showing the id as text.
test('a ticket link is optional but must be a rooted template with a placeholder', () => {
  assert.equal(normalizeTrackerSettings({}).data.ticketLinkPath, '');
  assert.equal(normalizeTrackerSettings({ ticketLinkPath: '/tickets?id=' }).ok, false);
  assert.equal(normalizeTrackerSettings({ ticketLinkPath: 'tickets?id={id}' }).ok, false);
  const r = normalizeTrackerSettings({ ticketLinkPath: '/tickets?area=14&id={id}' });
  assert.equal(r.ok, true);
  assert.equal(r.data.ticketLinkPath, '/tickets?area=14&id={id}');
  // {num} is the other accepted placeholder, and is enough on its own.
  const num = normalizeTrackerSettings({ ticketLinkPath: '/ticket?id={num}' });
  assert.equal(num.ok, true);
  assert.equal(num.data.ticketLinkPath, '/ticket?id={num}');
  assert.match(normalizeTrackerSettings({ ticketLinkPath: '/ticket?id=x' }).error, /\{num\}/);
});

// A service desk shows a ticket as a padded reference but addresses it in a URL
// by its number, so the two cannot be the same placeholder. This is why {num}
// exists: HaloITSM stores "PR-0164935" in the work item and serves the ticket at
// /ticket?id=164935 — substituting the reference gives "ticket not found".
test('the ticket number is the digits of the reference, without prefix or padding', () => {
  assert.equal(ticketNumber('PR-0164935'), '164935');
  assert.equal(ticketNumber('0167265'), '167265');
  assert.equal(ticketNumber('164935'), '164935');
  assert.equal(ticketNumber('PM21435'), '21435');
  assert.equal(ticketNumber(' PR-0164935 '), '164935');
  // A reference with no digits has no number; the caller shows the reference
  // rather than linking to an empty id.
  assert.equal(ticketNumber('ABC'), '');
  assert.equal(ticketNumber(''), '');
  assert.equal(ticketNumber(null), '');
  assert.equal(ticketNumber(undefined), '');
  // All-zero padding must not collapse to a link to ticket 0.
  assert.equal(ticketNumber('PR-0000'), '');
});

test('a template says where the id goes with either placeholder', () => {
  assert.equal(hasIdPlaceholder('/ticket?id={id}'), true);
  assert.equal(hasIdPlaceholder('/ticket?id={num}'), true);
  assert.equal(hasIdPlaceholder('/ticket?id=164935'), false);
  assert.equal(hasIdPlaceholder(''), false);
  assert.equal(hasIdPlaceholder(null), false);
});

test('the link patterns keep {id} for the browser to substitute', () => {
  const { workItemUrl, issueTrackerUrl } = trackerLinkPatterns({
    azureOrgUrl: 'https://dev.azure.com/Org/',
    azureProject: 'My Project',
    haloBaseUrl: 'https://sd.example.com/',
    ticketLinkPath: '/tickets?area=14&id={id}',
  });
  // The work item route is fixed, so it is derived rather than configured; the
  // project name is escaped because it may contain spaces.
  assert.equal(workItemUrl, 'https://dev.azure.com/Org/My%20Project/_workitems/edit/{id}');
  assert.equal(issueTrackerUrl, 'https://sd.example.com/tickets?area=14&id={id}');
});

// A half-configured project must not produce a link to nowhere: the UI reads an
// empty pattern as "show the id as text".
test('an incomplete tracker configuration yields no link pattern', () => {
  assert.deepEqual(trackerLinkPatterns(null), { workItemUrl: '', issueTrackerUrl: '' });
  // The organisation alone does not say which project the work item is in.
  assert.equal(trackerLinkPatterns({ azureOrgUrl: 'https://dev.azure.com/Org' }).workItemUrl, '');
  // The service desk's API host is not its web view, so the path is required.
  assert.equal(trackerLinkPatterns({ haloBaseUrl: 'https://sd.example.com' }).issueTrackerUrl, '');
});

test('the ticket URL follows the configured template', () => {
  const settings = { haloBaseUrl: 'https://sd.example.com', ticketPath: '/v2/incidents/{id}/detail' };
  assert.equal(ticketUrl(settings, '167265'), 'https://sd.example.com/v2/incidents/167265/detail');
  // A ticket id is stored verbatim, so it may need escaping.
  assert.equal(ticketUrl(settings, 'PR/1'), 'https://sd.example.com/v2/incidents/PR%2F1/detail');
  // The default applies when a project never set a path.
  assert.equal(ticketUrl({ haloBaseUrl: 'https://sd.example.com' }, '9'), 'https://sd.example.com/api/Tickets/9');
  assert.equal(ticketUrl({}, '9'), '');
  assert.equal(ticketUrl({ haloBaseUrl: 'https://sd.example.com' }, ''), '');
});

// Missing configuration is a normal state, not a fault: the tester types the
// ticket id by hand exactly as they did before the lookup existed.
test('the lookup reports itself unconfigured until URL, project and secret are all set', () => {
  assert.equal(azureLookupConfigured(null), false);
  assert.equal(azureLookupConfigured({ azureOrgUrl: 'https://dev.azure.com/O', azureProject: 'P' }), false);
  assert.equal(azureLookupConfigured({ azureOrgUrl: 'https://dev.azure.com/O', azurePat: 'x' }), false);
  assert.equal(
    azureLookupConfigured({ azureOrgUrl: 'https://dev.azure.com/O', azureProject: 'P', azurePat: 'x' }),
    true
  );
  assert.equal(haloLookupConfigured({ haloBaseUrl: 'https://sd.example.com' }), false);
  assert.equal(haloLookupConfigured({ haloBaseUrl: 'https://sd.example.com', haloApiKey: 'k' }), true);
});

// A work item id is unique across the whole tracker organisation, but the
// project-scoped route answers 404 for an item filed under a neighbouring
// project. That is what made the lookup work for one RollDesk project and
// silently find nothing for the next one over: same organisation, bugs filed in
// a different tracker project, no title / ticket / state filled in and no
// explanation on screen.
test('a work item is looked up under the project first, then organisation-wide', () => {
  const settings = { azureOrgUrl: 'https://dev.azure.com/Org', azureProject: 'Product Core' };
  assert.deepEqual(workItemLookupUrls(settings, '41231'), [
    'https://dev.azure.com/Org/Product%20Core/_apis/wit/workitems/41231?api-version=7.0',
    'https://dev.azure.com/Org/_apis/wit/workitems/41231?api-version=7.0',
  ]);
});

// One product is split across several tracker projects — the bugs of the main
// application in one, the e-services portal in a second, the next major version in
// a third. A single configured project left every id from the others to the
// organisation-wide route, which a project-scoped PAT answers with 403; so the
// setting is a list and every entry is tried.
test('every configured tracker project is tried, in order, before the organisation', () => {
  const settings = {
    azureOrgUrl: 'https://dev.azure.com/Org',
    azureProjects: ['PiK', 'PiK 2.0', 'Portal e-usług'],
  };
  assert.deepEqual(workItemLookupUrls(settings, '41231'), [
    'https://dev.azure.com/Org/PiK/_apis/wit/workitems/41231?api-version=7.0',
    'https://dev.azure.com/Org/PiK%202.0/_apis/wit/workitems/41231?api-version=7.0',
    'https://dev.azure.com/Org/Portal%20e-us%C5%82ug/_apis/wit/workitems/41231?api-version=7.0',
    'https://dev.azure.com/Org/_apis/wit/workitems/41231?api-version=7.0',
  ]);
});

test('trackerProjects reads a list, a typed string and the single old setting', () => {
  assert.deepEqual(trackerProjects({ azureProjects: ['A', 'B'] }), ['A', 'B']);
  // What an admin types into one box.
  assert.deepEqual(trackerProjects({ azureProjects: ' PiK , PiK 2.0 ,, Portal e-usług ' }),
    ['PiK', 'PiK 2.0', 'Portal e-usług']);
  assert.deepEqual(trackerProjects({ azureProjects: 'A\nB;C' }), ['A', 'B', 'C']);
  // A project configured before the list existed keeps working untouched.
  assert.deepEqual(trackerProjects({ azureProject: 'PiK' }), ['PiK']);
  // The list wins when both are present (it is what the form writes).
  assert.deepEqual(trackerProjects({ azureProjects: ['A'], azureProject: 'B' }), ['A']);
  // Azure treats project names case-insensitively, so a repeat is not a second request.
  assert.deepEqual(trackerProjects({ azureProjects: ['PiK', 'pik'] }), ['PiK']);
  assert.deepEqual(trackerProjects({}), []);
  assert.deepEqual(trackerProjects(null), []);
  // Bounded: each entry is a request a failed lookup makes before giving up.
  assert.equal(trackerProjects({ azureProjects: Array.from({ length: 40 }, (_, i) => 'P' + i) }).length,
    MAX_TRACKER_PROJECTS);
});

test('normalizeTrackerSettings stores the list and keeps the primary under the old key', () => {
  const r = normalizeTrackerSettings({
    azureOrgUrl: 'https://dev.azure.com/Org',
    azureProjects: 'PiK, Portal e-usług',
    ticketPath: DEFAULT_TICKET_PATH,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.azureProjects, ['PiK', 'Portal e-usług']);
  // So a downgrade — and anything still reading one name — sees a working setting.
  assert.equal(r.data.azureProject, 'PiK');
});

test('the work-item lookup counts as configured with any project on the list', () => {
  const base = { azureOrgUrl: 'https://dev.azure.com/O', azurePat: 'x' };
  assert.equal(azureLookupConfigured(Object.assign({ azureProjects: ['P', 'Q'] }, base)), true);
  assert.equal(azureLookupConfigured(Object.assign({ azureProjects: [] }, base)), false);
  assert.equal(azureLookupConfigured(Object.assign({ azureProject: 'P' }, base)), true);
});

test('the work item link is built under the first configured project', () => {
  const { workItemUrl } = trackerLinkPatterns({
    azureOrgUrl: 'https://dev.azure.com/Org', azureProjects: ['PiK', 'Portal e-usług'],
  });
  // Azure resolves /_workitems/edit/<id> to the item's own project, so one pattern
  // opens an item from either.
  assert.equal(workItemUrl, 'https://dev.azure.com/Org/PiK/_workitems/edit/{id}');
});

test('with no project configured the organisation-wide route is the only one', () => {
  assert.deepEqual(workItemLookupUrls({ azureOrgUrl: 'https://dev.azure.com/Org' }, '7'), [
    'https://dev.azure.com/Org/_apis/wit/workitems/7?api-version=7.0',
  ]);
  // Nothing to call without an organisation or an id.
  assert.deepEqual(workItemLookupUrls({ azureProject: 'P' }, '7'), []);
  assert.deepEqual(workItemLookupUrls({ azureOrgUrl: 'https://dev.azure.com/Org' }, ''), []);
  // http is refused for the same reason as everywhere else: the request carries a PAT.
  assert.deepEqual(workItemLookupUrls({ azureOrgUrl: 'http://dev.azure.com/Org' }, '7'), []);
});

// Which project the item actually lives in is read so the caller can say the
// lookup answered from somewhere other than the configured project — a stale
// setting that works anyway is worth reporting, not hiding.
test('the work item reports the tracker project it was found in', () => {
  const item = workItemFromAzure({
    id: 41231,
    fields: {
      'System.Title': 'Report totals are wrong',
      'System.State': 'Resolved',
      'System.TeamProject': 'Product Core',
      [DEFAULT_TICKET_FIELD]: 'PR-0167134',
    },
  });
  assert.equal(item.project, 'Product Core');
  assert.equal(item.title, 'Report totals are wrong');
  assert.equal(item.ticket, 'PR-0167134');
  // Absent stays absent rather than becoming an empty string on the entry.
  assert.equal(workItemFromAzure({ id: 1, fields: {} }).project, undefined);
});

// ---- Suggestions while typing an id ----------------------------------------
//
// Typing the whole id and hoping was the wrong way round: the tester reads a
// number off a board and wants to be shown which work item it is, which is what
// the tracker's own search box does.

test('a fragment is at least two digits', () => {
  assert.equal(parseWorkItemFragment('4123'), '4123');
  assert.equal(parseWorkItemFragment(' 41 '), '41');
  assert.equal(parseWorkItemFragment('#4123'), '4123');
  // One digit matches most of a backlog — that is a request per keystroke for noise.
  assert.equal(parseWorkItemFragment('4'), '');
  for (const bad of ['', '   ', null, undefined, 'abc', 'PR-0167134']) {
    assert.equal(parseWorkItemFragment(bad), '', `expected '' for ${JSON.stringify(bad)}`);
  }
});

test('search runs against the hosted search service, derived from the organisation URL', () => {
  assert.equal(
    workItemSearchUrl({ azureOrgUrl: 'https://dev.azure.com/InventOn' }),
    'https://almsearch.dev.azure.com/InventOn/_apis/search/workitemsearchresults?api-version=7.1'
  );
  // Anything that is not hosted Azure DevOps has no search host — the feature is
  // absent rather than broken, and the id lookup still answers.
  assert.equal(workItemSearchUrl({ azureOrgUrl: 'https://tfs.example.com/tfs/Coll' }), '');
  assert.equal(workItemSearchUrl({ azureOrgUrl: 'https://dev.azure.com' }), '');
  assert.equal(workItemSearchUrl({ azureOrgUrl: 'http://dev.azure.com/Org' }), '');
  assert.equal(workItemSearchUrl({}), '');
});

test('the search is scoped to the projects the RollDesk project names', () => {
  const body = workItemSearchBody('4123', { azureProjects: ['PiK', 'Portal e-usług'] });
  assert.equal(body.searchText, '4123');
  assert.equal(body.$top, SEARCH_TOP);
  assert.deepEqual(body.filters, { 'System.TeamProject': ['PiK', 'Portal e-usług'] });
  // With none named, the organisation is searched — the same fallback as the lookup.
  assert.equal(workItemSearchBody('4123', {}).filters, undefined);
  // Bounded, so a caller cannot ask for the whole backlog.
  assert.equal(workItemSearchBody('4123', {}, 5000).$top, 50);
});

test('suggestions are read from either spelling of the field keys', () => {
  // The search service answers in lower case; the work-item API uses reference names.
  const items = workItemsFromSearch({
    results: [
      { project: { name: 'PiK' }, fields: { 'system.id': '41231', 'system.title': 'Bad driver data', 'system.state': 'Resolved', 'system.workitemtype': 'Bug' } },
      { fields: { 'System.Id': '41232', 'System.Title': 'Second', 'System.State': 'New' } },
      { fields: { 'system.title': 'no id — dropped' } },
      null,
    ],
  });
  assert.deepEqual(items.map((i) => i.id), ['41231', '41232']);
  assert.equal(items[0].title, 'Bad driver data');
  assert.equal(items[0].state, 'Resolved');
  assert.equal(items[0].type, 'Bug');
  assert.equal(items[0].project, 'PiK');
  assert.deepEqual(workItemsFromSearch(null), []);
  assert.deepEqual(workItemsFromSearch({ results: 'nope' }), []);
});
