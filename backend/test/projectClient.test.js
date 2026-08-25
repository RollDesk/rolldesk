// Moving a project under another client. The rules live in a pure module, so the
// interesting cases — an unknown client, a display name the caller made up, and
// which client accounts lose the project — are exercised without a database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeClientMove, staleClientGrants, visibleProjectKeys,
  CLIENT_KEY_MAX, CLIENT_NAME_MAX,
} from '../src/projectClient.js';

const CLIENTS = [
  { key: 'acme', name: 'ACME S.A.', domain: 'acme.example' },
  { key: 'globex', name: 'Globex', domain: 'globex.example' },
];

test('a move names an existing client and takes its stored name', () => {
  const r = normalizeClientMove({ clientKey: 'globex', clientName: 'whatever' }, CLIENTS);
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { clientKey: 'globex', clientName: 'Globex' });
});

// The name in the request is not authoritative: two projects of one client that
// disagree about what the client is called group into two rows in every list.
test('the request cannot rename the client it moves the project to', () => {
  const r = normalizeClientMove({ clientKey: 'acme', clientName: 'ACME (old name)' }, CLIENTS);
  assert.equal(r.data.clientName, 'ACME S.A.');
});

test('a client nobody defined is refused', () => {
  const r = normalizeClientMove({ clientKey: 'initech' }, CLIENTS);
  assert.equal(r.ok, false);
  assert.match(r.error, /Unknown client/);
});

test('a move with no client at all is refused', () => {
  assert.equal(normalizeClientMove({}, CLIENTS).ok, false);
  assert.equal(normalizeClientMove({ clientKey: '   ' }, CLIENTS).ok, false);
  assert.equal(normalizeClientMove(null, CLIENTS).ok, false);
});

test('an over-long client key is refused rather than truncated', () => {
  const r = normalizeClientMove({ clientKey: 'a'.repeat(CLIENT_KEY_MAX + 1) }, CLIENTS);
  assert.equal(r.ok, false);
  assert.match(r.error, /too long/);
});

// An instance that has never opened the Clients view has no saved collection,
// yet its projects still each have a client. Refusing every move there would
// make the feature depend on a screen the admin need not have visited.
test('with no stored client list the request supplies both key and name', () => {
  const r = normalizeClientMove({ clientKey: 'globex', clientName: 'Globex' }, null);
  assert.deepEqual(r.data, { clientKey: 'globex', clientName: 'Globex' });
  assert.equal(normalizeClientMove({ clientKey: 'globex' }, null).ok, false);
  assert.equal(normalizeClientMove({ clientKey: 'Globex Inc.', clientName: 'Globex' }, []).ok, false);
});

test('a client name is clamped to what the column is meant to hold', () => {
  const r = normalizeClientMove({ clientKey: 'globex', clientName: 'G'.repeat(CLIENT_NAME_MAX + 50) }, []);
  assert.equal(r.data.clientName.length, CLIENT_NAME_MAX);
});

// --- Who loses the project ------------------------------------------------

const USERS = [
  { id: 1, email: 'ops@acme.example', role: 'client', clientKey: 'acme', projects: ['acme:core'] },
  { id: 2, email: 'pm@acme.example', role: 'client', clientKey: 'acme', projects: ['acme:core', 'acme:portal'] },
  { id: 3, email: 'ops@globex.example', role: 'client', clientKey: 'globex', projects: ['acme:core'] },
  { id: 4, email: 'rm@dxc.example', role: 'rm', clientKey: null, projects: [] },
  { id: 5, email: 'dep@dxc.example', role: 'installer', clientKey: null, projects: ['acme:core'] },
  { id: 6, email: 'stray@example.com', role: 'client', clientKey: null, projects: ['acme:core'] },
];

test('the previous client\'s accounts lose the project, the new one\'s keep it', () => {
  const stale = staleClientGrants(USERS, 'acme:core', 'globex');
  assert.deepEqual(stale.map((u) => u.id), [1, 2, 6]);
});

// A deployer or release manager is our own team: their grant is a work
// assignment, not a window into a client's data, and a move must not clear it.
test('team accounts keep their project assignments', () => {
  const stale = staleClientGrants(USERS, 'acme:core', 'globex');
  assert.equal(stale.some((u) => u.role !== 'client'), false);
});

test('an account granted a different project is untouched', () => {
  const stale = staleClientGrants(USERS, 'acme:portal', 'globex');
  assert.deepEqual(stale.map((u) => u.id), [2]);
});

test('moving a project to the client that already owns it revokes nothing', () => {
  assert.deepEqual(staleClientGrants(USERS, 'acme:core', 'acme').map((u) => u.id), [3, 6]);
});

test('staleClientGrants survives missing input', () => {
  assert.deepEqual(staleClientGrants(null, 'acme:core', 'acme'), []);
  assert.deepEqual(staleClientGrants(USERS, '', 'acme'), []);
  assert.deepEqual(staleClientGrants([{ role: 'client' }], 'acme:core', 'acme'), []);
});

// --- Defence in depth on the read path ------------------------------------

test('a client account never reads a project owned by another client', () => {
  const owners = { 'acme:core': 'globex', 'acme:portal': 'acme' };
  assert.deepEqual(
    visibleProjectKeys(['acme:core', 'acme:portal'], owners, 'acme'),
    ['acme:portal']
  );
});

// Projects created before the client was recorded in the JSONB have no owner on
// file. Dropping those would take away access that works today, so an unknown
// owner is left alone and only a positive mismatch is filtered out.
test('a project with no recorded client keeps behaving as before', () => {
  const owners = new Map([['acme:core', ''], ['acme:portal', null]]);
  assert.deepEqual(
    visibleProjectKeys(['acme:core', 'acme:portal', 'acme:field'], owners, 'acme'),
    ['acme:core', 'acme:portal', 'acme:field']
  );
});

test('an account with no client on file is scoped by its grants alone', () => {
  const owners = { 'acme:core': 'globex' };
  assert.deepEqual(visibleProjectKeys(['acme:core'], owners, null), ['acme:core']);
});

test('visibleProjectKeys accepts a Map or a plain object and survives neither', () => {
  assert.deepEqual(visibleProjectKeys(['a'], new Map([['a', 'x']]), 'x'), ['a']);
  assert.deepEqual(visibleProjectKeys(['a'], { a: 'x' }, 'y'), []);
  assert.deepEqual(visibleProjectKeys(['a'], null, 'y'), ['a']);
  assert.deepEqual(visibleProjectKeys(null, { a: 'x' }, 'y'), []);
});
