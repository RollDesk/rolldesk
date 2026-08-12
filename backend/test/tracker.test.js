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
