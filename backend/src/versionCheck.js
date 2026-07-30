// Update check — asks GitHub for the newest published release and caches the
// answer in the backend process.
//
// This used to run in the browser: every open tab hit api.github.com directly.
// Anonymous GitHub API calls are capped at 60/hour *per IP*, so a handful of
// users behind one office NAT exhausted the quota and the badge fell back to
// "latest unknown" — and an installation behind a restrictive firewall could
// never check at all. Doing it here means one upstream call per TTL per
// instance, regardless of how many tabs are open, and only the backend needs
// outbound access.
//
// The cache logic is pure (clock and fetch are injected) so it can be unit
// tested without a network; `versionCache` below is the single live instance.
import { config } from './config.js';

// Strip a leading `v` from a tag name: releases are tagged `v0.13.2` but the
// app compares bare `0.13.2`.
export function normalizeTag(tag) {
  const s = String(tag == null ? '' : tag).trim();
  if (!s) return null;
  return s.replace(/^v/i, '') || null;
}

// Pick the version out of a GitHub /releases/latest payload.
export function latestFromRelease(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return normalizeTag(payload.tag_name || payload.name || '');
}

// A single-value cache with a success TTL and a shorter failure TTL.
//
// On failure the last known good value is kept and still served (a rate limit
// is no reason to forget which version is out there); only `checkedAt` and the
// error are updated. The short failure TTL means a transient outage is retried
// soon without hammering an upstream that is already refusing us.
//
// Concurrent callers share one in-flight request, so N tabs refreshing at once
// still produce a single upstream call.
export function createVersionCache({
  fetchLatest,
  ttlMs = 60 * 60 * 1000,
  errorTtlMs = 5 * 60 * 1000,
  now = () => Date.now(),
} = {}) {
  let latest = null;        // last known good version, e.g. '0.13.2'
  let checkedAt = null;     // epoch ms of the last completed attempt
  let error = null;         // message from the last failed attempt
  let expiresAt = 0;        // when the cached state goes stale
  let inFlight = null;

  function snapshot() {
    return {
      latest,
      checkedAt: checkedAt === null ? null : new Date(checkedAt).toISOString(),
      error,
      stale: now() >= expiresAt,
    };
  }

  async function refresh() {
    try {
      const value = await fetchLatest();
      latest = value;
      error = value ? null : 'No published release found';
      checkedAt = now();
      // A reachable-but-empty answer is not a failure worth retrying quickly.
      expiresAt = checkedAt + ttlMs;
    } catch (err) {
      error = err && err.message ? err.message : String(err);
      checkedAt = now();
      expiresAt = checkedAt + errorTtlMs;
    } finally {
      inFlight = null;
    }
    return snapshot();
  }

  return {
    // Serve from cache while fresh; otherwise refresh (joining an in-flight
    // call rather than starting a second one).
    async get() {
      if (checkedAt !== null && now() < expiresAt) return snapshot();
      if (!inFlight) inFlight = refresh();
      return inFlight;
    },
    // Current state without ever reaching out — used by callers that must not
    // block (and by tests).
    peek: snapshot,
  };
}

// Fetch the newest release from GitHub. A token (GITHUB_TOKEN) is optional and
// only raises the rate limit; the repository is public.
async function fetchLatestFromGitHub() {
  const { repo, token, timeoutMs } = config.versionCheck;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'rolldesk' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    // Rate limiting is the common, expected failure — name it so the UI can say
    // something more useful than "could not reach GitHub".
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
      throw new Error('GitHub API rate limit exceeded');
    }
    throw new Error(`GitHub API ${res.status}`);
  }
  return latestFromRelease(await res.json());
}

export const versionCache = createVersionCache({
  fetchLatest: fetchLatestFromGitHub,
  ttlMs: config.versionCheck.ttlMs,
});
