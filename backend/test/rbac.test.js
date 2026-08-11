import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireWriteRole, requirePackageRole, isScopedRole } from '../src/rbac.js';

// The guards are plain middleware over req.auth.role, so they can be exercised
// without a database or a server: a fake res records the status/body it was sent
// and next() records that the request was let through.
function run(guard, role) {
  const req = role === undefined ? {} : { auth: { role } };
  const result = { passed: false, status: 0, body: null };
  const res = {
    status(code) { result.status = code; return res; },
    json(body) { result.body = body; return res; },
  };
  guard(req, res, () => { result.passed = true; });
  return result;
}

const ROLES = ['admin', 'rm', 'tester', 'installer', 'client'];

test('only admin, rm and installer may write deployments and projects', () => {
  const allowed = ROLES.filter((r) => run(requireWriteRole, r).passed);
  assert.deepEqual(allowed, ['admin', 'rm', 'installer']);
});

// The point of an allow-list: a role invented later has no write access until
// someone adds it deliberately. `forbidClient` used to give it away by default.
test('a role the write guard has never heard of is refused', () => {
  const result = run(requireWriteRole, 'auditor');
  assert.equal(result.passed, false);
  assert.equal(result.status, 403);
});

test('a request with no auth at all cannot write', () => {
  assert.equal(run(requireWriteRole, undefined).passed, false);
  assert.equal(run(requireWriteRole, '').passed, false);
});

test('only admin, rm and tester may manage release packages', () => {
  const allowed = ROLES.filter((r) => run(requirePackageRole, r).passed);
  assert.deepEqual(allowed, ['admin', 'rm', 'tester']);
});

test('a deployer cannot assemble packages and a tester cannot write deployments', () => {
  assert.equal(run(requirePackageRole, 'installer').passed, false);
  assert.equal(run(requireWriteRole, 'tester').passed, false);
});

// Read endpoints narrow to the projects on the account for these roles. Missing
// a role here does not fail loudly — it silently widens what that role can read.
test('deployers and testers read within their granted projects; nobody else is scoped that way', () => {
  const scoped = ROLES.filter((r) => isScopedRole({ auth: { role: r } }));
  assert.deepEqual(scoped, ['tester', 'installer']);
  assert.equal(isScopedRole({}), false);
});
