// Unit tests for the update-check cache. The clock and the upstream fetch are
// injected, so these run without a network and without waiting for real time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVersionCache, latestFromRelease, normalizeTag } from '../src/versionCheck.js';

test('normalizeTag strips a leading v and handles empties', () => {
  assert.equal(normalizeTag('v0.13.2'), '0.13.2');
  assert.equal(normalizeTag('V1.0.0'), '1.0.0');
  assert.equal(normalizeTag('0.13.2'), '0.13.2');
  assert.equal(normalizeTag('  v2.1.0  '), '2.1.0');
  assert.equal(normalizeTag(''), null);
  assert.equal(normalizeTag(null), null);
  assert.equal(normalizeTag(undefined), null);
});

test('latestFromRelease prefers tag_name and falls back to name', () => {
  assert.equal(latestFromRelease({ tag_name: 'v0.13.2', name: 'v9.9.9' }), '0.13.2');
  assert.equal(latestFromRelease({ name: 'v0.12.0' }), '0.12.0');
  assert.equal(latestFromRelease({}), null);
  assert.equal(latestFromRelease(null), null);
});

test('the first call fetches and the cache serves subsequent ones', async () => {
  let calls = 0;
  let now = 1000;
  const cache = createVersionCache({
    fetchLatest: async () => { calls++; return '0.13.2'; },
    ttlMs: 60_000,
    now: () => now,
  });

  const first = await cache.get();
  assert.equal(first.latest, '0.13.2');
  assert.equal(first.error, null);
  assert.equal(calls, 1);

  now += 59_000; // still inside the TTL
  const second = await cache.get();
  assert.equal(second.latest, '0.13.2');
  assert.equal(calls, 1, 'a fresh cache must not call upstream again');
});

test('the cache refetches once the TTL expires', async () => {
  let calls = 0;
  let now = 0;
  const cache = createVersionCache({
    fetchLatest: async () => { calls++; return calls === 1 ? '0.13.2' : '0.14.0'; },
    ttlMs: 60_000,
    now: () => now,
  });

  await cache.get();
  now += 60_001;
  const after = await cache.get();
  assert.equal(calls, 2);
  assert.equal(after.latest, '0.14.0');
});

test('a failure keeps the last known good version and records the reason', async () => {
  let mode = 'ok';
  let now = 0;
  const cache = createVersionCache({
    fetchLatest: async () => {
      if (mode === 'boom') throw new Error('GitHub API rate limit exceeded');
      return '0.13.2';
    },
    ttlMs: 60_000,
    errorTtlMs: 5_000,
    now: () => now,
  });

  await cache.get();
  mode = 'boom';
  now += 60_001;
  const failed = await cache.get();
  assert.equal(failed.latest, '0.13.2', 'the last good value must survive a failed refresh');
  assert.equal(failed.error, 'GitHub API rate limit exceeded');
});

test('a failure is retried on the shorter error TTL, not the full one', async () => {
  let calls = 0;
  let now = 0;
  const cache = createVersionCache({
    fetchLatest: async () => { calls++; throw new Error('offline'); },
    ttlMs: 60_000,
    errorTtlMs: 5_000,
    now: () => now,
  });

  await cache.get();
  assert.equal(calls, 1);

  now += 4_000; // inside the error TTL — no retry yet
  await cache.get();
  assert.equal(calls, 1);

  now += 2_000; // past the error TTL (6s total), well before the 60s success TTL
  await cache.get();
  assert.equal(calls, 2, 'a failed check must be retried on the short TTL');
});

test('concurrent callers share a single upstream request', async () => {
  let calls = 0;
  const cache = createVersionCache({
    fetchLatest: async () => {
      calls++;
      await new Promise(r => setImmediate(r));
      return '0.13.2';
    },
    ttlMs: 60_000,
    now: () => 0,
  });

  const results = await Promise.all([cache.get(), cache.get(), cache.get()]);
  assert.equal(calls, 1, 'three simultaneous callers must not make three calls');
  results.forEach(r => assert.equal(r.latest, '0.13.2'));
});

test('a reachable upstream with no releases reports an error but does not spin', async () => {
  let calls = 0;
  let now = 0;
  const cache = createVersionCache({
    fetchLatest: async () => { calls++; return null; },
    ttlMs: 60_000,
    errorTtlMs: 5_000,
    now: () => now,
  });

  const state = await cache.get();
  assert.equal(state.latest, null);
  assert.equal(state.error, 'No published release found');

  now += 10_000; // past the error TTL but inside the success TTL
  await cache.get();
  assert.equal(calls, 1, 'an empty-but-successful answer uses the full TTL');
});

test('peek never triggers a fetch', async () => {
  let calls = 0;
  const cache = createVersionCache({
    fetchLatest: async () => { calls++; return '0.13.2'; },
    now: () => 0,
  });

  const before = cache.peek();
  assert.equal(before.latest, null);
  assert.equal(before.checkedAt, null);
  assert.equal(calls, 0);

  await cache.get();
  assert.equal(cache.peek().latest, '0.13.2');
  assert.equal(calls, 1);
});
