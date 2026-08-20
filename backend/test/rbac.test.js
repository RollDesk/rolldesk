import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  requireWriteRole, requirePackageRole, requirePackageApprovalRole, isScopedRole, isPM,
} from '../src/rbac.js';

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

const ROLES = ['admin', 'rm', 'pm', 'tester', 'installer', 'client'];

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
test('deployers, testers and project managers read within their granted projects', () => {
  const scoped = ROLES.filter((r) => isScopedRole({ auth: { role: r } }));
  assert.deepEqual(scoped, ['pm', 'tester', 'installer']);
  assert.equal(isScopedRole({}), false);
});

// The approval gate. Who may clear a release is the whole point of the role, so
// this is the test to read when someone asks why they cannot approve a package.
test('only a project manager and an administrator may clear a release for deployment', () => {
  const allowed = ROLES.filter((r) => run(requirePackageApprovalRole, r).passed);
  assert.deepEqual(allowed, ['admin', 'pm']);
  // Not the people who assemble the package (that is the gate approving itself),
  // and not the release manager who is about to plan the rollout from it.
  assert.equal(run(requirePackageApprovalRole, 'tester').passed, false);
  assert.equal(run(requirePackageApprovalRole, 'rm').passed, false);
  assert.equal(run(requirePackageApprovalRole, undefined).passed, false);
});

test('a project manager writes no deployments and assembles no packages', () => {
  // Their one power is the clearance; everything else about a release stays with
  // the roles that had it.
  assert.equal(run(requireWriteRole, 'pm').passed, false);
  assert.equal(run(requirePackageRole, 'pm').passed, false);
  assert.equal(isPM({ auth: { role: 'pm' } }), true);
  assert.equal(isPM({ auth: { role: 'rm' } }), false);
  assert.equal(isPM({}), false);
});
