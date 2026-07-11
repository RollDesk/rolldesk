import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAllowed,
  isAllowed,
  clientIpFromRequest,
  createIpAllowlist,
} from '../src/ipAllowlist.js';

test('isAllowed matches an exact IPv4 address', () => {
  const compiled = parseAllowed(['203.0.113.4']);
  assert.equal(isAllowed('203.0.113.4', compiled), true);
  assert.equal(isAllowed('203.0.113.5', compiled), false);
});

test('isAllowed matches an IPv4 CIDR range', () => {
  const compiled = parseAllowed(['10.8.0.0/24']);
  assert.equal(isAllowed('10.8.0.1', compiled), true);
  assert.equal(isAllowed('10.8.0.255', compiled), true);
  assert.equal(isAllowed('10.8.1.1', compiled), false);
});

test('isAllowed strips the IPv4-mapped IPv6 prefix', () => {
  const compiled = parseAllowed(['198.51.100.10']);
  assert.equal(isAllowed('::ffff:198.51.100.10', compiled), true);
});

test('isAllowed matches an IPv6 CIDR range', () => {
  const compiled = parseAllowed(['2001:db8::/32']);
  assert.equal(isAllowed('2001:db8::1', compiled), true);
  assert.equal(isAllowed('2001:db9::1', compiled), false);
});

test('isAllowed does not cross address families', () => {
  const compiled = parseAllowed(['10.0.0.0/8']);
  assert.equal(isAllowed('2001:db8::1', compiled), false);
});

test('isAllowed returns false for an unparseable address', () => {
  const compiled = parseAllowed(['10.0.0.0/8']);
  assert.equal(isAllowed('not-an-ip', compiled), false);
  assert.equal(isAllowed('', compiled), false);
});

test('isAllowed supports mixed entries', () => {
  const compiled = parseAllowed(['203.0.113.4', '198.51.100.0/24', '10.8.0.0/24']);
  assert.equal(isAllowed('203.0.113.4', compiled), true);
  assert.equal(isAllowed('198.51.100.77', compiled), true);
  assert.equal(isAllowed('192.0.2.1', compiled), false);
});

test('clientIpFromRequest uses X-Forwarded-For when trustProxy is on', () => {
  const req = { ip: '10.0.0.1', headers: { 'x-forwarded-for': '203.0.113.4, 10.0.0.1' } };
  assert.equal(clientIpFromRequest(req, true), '203.0.113.4');
});

test('clientIpFromRequest ignores X-Forwarded-For when trustProxy is off', () => {
  const req = { ip: '10.0.0.1', headers: { 'x-forwarded-for': '203.0.113.4' } };
  assert.equal(clientIpFromRequest(req, false), '10.0.0.1');
});

// Minimal Express-like response double.
function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

test('createIpAllowlist with an empty list allows every request', () => {
  const mw = createIpAllowlist({ allowedIps: [] });
  let called = false;
  const res = fakeRes();
  mw({ ip: '8.8.8.8', headers: {} }, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(res.statusCode, 200);
});

test('createIpAllowlist allows an IP on the list', () => {
  const mw = createIpAllowlist({ allowedIps: ['203.0.113.4'] });
  let called = false;
  const res = fakeRes();
  mw({ ip: '203.0.113.4', headers: {} }, res, () => { called = true; });
  assert.equal(called, true);
});

test('createIpAllowlist rejects an IP not on the list with 403', () => {
  const mw = createIpAllowlist({ allowedIps: ['203.0.113.4'] });
  let called = false;
  const res = fakeRes();
  mw({ ip: '198.51.100.9', headers: {} }, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Access from this IP address is forbidden' });
});

test('createIpAllowlist honours a trusted proxy header', () => {
  const mw = createIpAllowlist({ allowedIps: ['203.0.113.4'], trustProxy: true });
  const allowed = fakeRes();
  let allowedNext = false;
  mw({ ip: '10.0.0.1', headers: { 'x-forwarded-for': '203.0.113.4' } }, allowed, () => { allowedNext = true; });
  assert.equal(allowedNext, true);

  const denied = fakeRes();
  let deniedNext = false;
  mw({ ip: '203.0.113.4', headers: { 'x-forwarded-for': '8.8.8.8' } }, denied, () => { deniedNext = true; });
  assert.equal(deniedNext, false);
  assert.equal(denied.statusCode, 403);
});
