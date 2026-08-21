import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authenticator } from 'otplib';
import {
  hashPassword,
  verifyPassword,
  signToken,
  signSessionToken,
  signStageToken,
  verifyToken,
  generateMfaSecret,
  otpauthUrl,
  verifyTotp,
  generateApiToken,
  hashApiToken,
  maskApiToken,
  isApiToken,
  API_TOKEN_PREFIX,
  liveAuthDecision,
} from '../src/auth.js';

const SECRET = 'test-secret-for-unit-tests';

test('password hash/verify round-trip', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.notEqual(hash, 'correct horse battery');
  assert.equal(await verifyPassword('correct horse battery', hash), true);
  assert.equal(await verifyPassword('wrong password', hash), false);
});

test('verifyPassword returns false for a missing hash', async () => {
  assert.equal(await verifyPassword('anything', null), false);
});

test('session token signs and verifies with the session stage', () => {
  const token = signSessionToken({ id: 7, email: 'a@example.com', role: 'admin' }, { secret: SECRET });
  const payload = verifyToken(token, { secret: SECRET, stage: 'session' });
  assert.equal(payload.sub, 7);
  assert.equal(payload.email, 'a@example.com');
  assert.equal(payload.role, 'admin');
  assert.equal(payload.stage, 'session');
});

test('verifyToken rejects a token whose stage does not match', () => {
  const token = signStageToken({ id: 1, email: 'a@example.com' }, 'mfa-setup', { secret: SECRET });
  // Correct stage passes.
  assert.doesNotThrow(() => verifyToken(token, { secret: SECRET, stage: 'mfa-setup' }));
  // Wrong stage is rejected.
  assert.throws(() => verifyToken(token, { secret: SECRET, stage: 'session' }), /Wrong token stage/);
});

test('verifyToken rejects a token signed with a different secret', () => {
  const token = signSessionToken({ id: 1, email: 'a@example.com', role: 'admin' }, { secret: SECRET });
  assert.throws(() => verifyToken(token, { secret: 'another-secret', stage: 'session' }));
});

test('verifyToken rejects an expired token', () => {
  const token = signToken({ sub: 1, stage: 'session' }, { secret: SECRET, expiresIn: -1 });
  assert.throws(() => verifyToken(token, { secret: SECRET }), /jwt expired/);
});

test('TOTP verifies a code produced from the same secret', () => {
  const secret = generateMfaSecret();
  const code = authenticator.generate(secret);
  assert.equal(verifyTotp(code, secret), true);
  assert.equal(verifyTotp('000000', secret), false);
  assert.equal(verifyTotp('', secret), false);
});

test('otpauthUrl embeds the issuer, account and secret', () => {
  const secret = generateMfaSecret();
  const url = otpauthUrl('user@example.com', secret, 'RollDesk');
  assert.match(url, /^otpauth:\/\/totp\//);
  assert.match(url, /RollDesk/);
  assert.ok(url.includes('secret=' + secret));
});

test('generateApiToken produces a prefixed token whose hash matches', () => {
  const { raw, hash, masked } = generateApiToken();
  assert.ok(raw.startsWith(API_TOKEN_PREFIX));
  assert.equal(isApiToken(raw), true);
  // Hash is deterministic and matches the standalone hasher.
  assert.equal(hash, hashApiToken(raw));
  assert.equal(hash.length, 64); // sha256 hex
  // Masked form hides the middle but keeps the prefix and last 4 chars.
  assert.ok(masked.includes('••••'));
  assert.ok(masked.endsWith(raw.slice(-4)));
  assert.ok(!masked.includes(raw.slice(12, -4)));
});

test('isApiToken only accepts the rd_live_ prefix', () => {
  assert.equal(isApiToken('rd_live_abc'), true);
  assert.equal(isApiToken('eyJhbGciOi...'), false); // a JWT
  assert.equal(isApiToken(''), false);
  assert.equal(isApiToken(null), false);
});

test('two generated tokens are distinct', () => {
  assert.notEqual(generateApiToken().raw, generateApiToken().raw);
});

// The role a session may act with is the account's role now, not the one the token
// was minted with — a 30-day session must not carry a permission somebody has
// already taken away, and a promotion must not need a sign-out to arrive.
test('a session acts with the role the account has now', () => {
  const claim = { sub: 7, email: 'old@dxc.test', role: 'tester', stage: 'session' };
  const d = liveAuthDecision(claim, { role: 'admin', email: 'new@dxc.test', archived: false });
  assert.equal(d.ok, true);
  assert.equal(d.auth.role, 'admin');
  // Everything else the token proved is kept: the subject is who is calling.
  assert.equal(d.auth.sub, 7);
  assert.equal(d.auth.stage, 'session');
  // A corrected e-mail travels with it; the claim's is the fallback.
  assert.equal(d.auth.email, 'new@dxc.test');
  assert.equal(liveAuthDecision(claim, { role: 'admin', email: null }).auth.email, 'old@dxc.test');
  // The claim is not mutated — the caller decides what to do with the decision.
  assert.equal(claim.role, 'tester');
});

test('a session whose account is gone or archived is not a session', () => {
  const claim = { sub: 7, role: 'admin', stage: 'session' };
  // Deleted between two requests: 401, so the browser signs out rather than
  // showing a screen of refusals.
  assert.deepEqual(liveAuthDecision(claim, null), {
    ok: false, status: 401, error: 'Authentication required',
  });
  assert.deepEqual(liveAuthDecision(claim, { role: 'admin', archived: true }), {
    ok: false, status: 401, error: 'Account disabled',
  });
  // No subject to look up is the same answer, without a query.
  assert.equal(liveAuthDecision({ role: 'admin' }, null).ok, false);
});
