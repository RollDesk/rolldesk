// Web Push delivery — the thin I/O wrapper around the routing rules in
// pushTargets.js, the same split as trackerService.js over tracker.js.
//
// Why a dependency: the payload has to be encrypted per subscription (RFC 8291 —
// ECDH on P-256, HKDF-SHA256 with fixed info strings, AES-128-GCM inside the
// aes128gcm content coding) and the request signed as a VAPID JWT (RFC 8292).
// Node has every primitive, but the composition is exacting and getting it subtly
// wrong means notifications that silently never arrive, or arrive unprotected.
// `web-push` is the reference implementation of both RFCs and does nothing else.
//
// Everything degrades to "push not configured" rather than failing: with no VAPID
// keypair on file, the endpoints report themselves off and no send is attempted,
// so an instance that never sets it up behaves exactly as it did before.
import webpush from 'web-push';
import { query } from './db.js';
import { config } from './config.js';
import { deploymentUrl } from './appLink.js';
import { selectPushUsers, notificationPayload } from './pushTargets.js';

const str = (v) => (v == null ? '' : String(v)).trim();

// A push service must never hold up the request the user is waiting on. The send
// is fire-and-forget anyway (see notifyEvent), but a stuck socket would still
// keep the process's handle count climbing.
const TIMEOUT_MS = 10000;

let configured = false;
try {
  if (config.push.publicKey && config.push.privateKey) {
    // The subject has to be a mailto: or an https: URL — a push service rejects
    // anything else, and it rejects it at send time, which is the worst moment to
    // find out. Prefer the configured contact, fall back to the app's own URL.
    const subject = config.push.subject
      || (config.appBaseUrl ? config.appBaseUrl : 'mailto:no-reply@rolldesk.local');
    webpush.setVapidDetails(subject, config.push.publicKey, config.push.privateKey);
    configured = true;
  }
} catch (err) {
  // A malformed keypair is a configuration mistake, not a reason to refuse to
  // start: everything else about the instance still works.
  console.warn(`[push] disabled — VAPID configuration rejected: ${err.message}`);
  configured = false;
}

export function pushConfigured() {
  return configured;
}

// The public half, handed to the browser so it can create a subscription. Not a
// secret — it is designed to be published.
export function publicKey() {
  return configured ? config.push.publicKey : '';
}

// --- subscriptions ----------------------------------------------------------

// Store (or refresh) one browser's subscription. The endpoint is the identity, so
// a browser that re-subscribes updates its keys instead of accumulating rows —
// which is what happens routinely, because a push service may rotate an endpoint
// and the browser then re-registers on its own.
export async function saveSubscription(userId, sub, userAgent) {
  const endpoint = str(sub && sub.endpoint);
  const keys = (sub && sub.keys) || {};
  const p256dh = str(keys.p256dh);
  const auth = str(keys.auth);
  if (!endpoint || !p256dh || !auth) return { ok: false, error: 'Incomplete push subscription' };
  if (!/^https:\/\//i.test(endpoint)) return { ok: false, error: 'A push endpoint must be https' };
  await query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (endpoint) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth,
           user_agent = EXCLUDED.user_agent,
           failures = 0`,
    [userId, endpoint.slice(0, 2000), p256dh.slice(0, 500), auth.slice(0, 500), str(userAgent).slice(0, 300)]
  );
  return { ok: true };
}

// Drop one subscription (the browser revoked it, or the user turned notifications
// off on this device). Scoped to the owner so an endpoint id cannot be used to
// unsubscribe somebody else's browser.
export async function deleteSubscription(userId, endpoint) {
  const { rowCount } = await query(
    'DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',
    [userId, str(endpoint)]
  );
  return rowCount > 0;
}

// This user's devices, for the settings view. Never returns the keys — they are
// of no use to the browser and there is no reason to hand them back out.
export async function listSubscriptions(userId) {
  const { rows } = await query(
    `SELECT endpoint, user_agent, created_at, last_sent_at
       FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at ASC`,
    [userId]
  );
  return rows.map((r) => ({
    endpoint: r.endpoint,
    userAgent: r.user_agent || null,
    createdAt: r.created_at,
    lastSentAt: r.last_sent_at,
  }));
}

// --- delivery ---------------------------------------------------------------

// Send one payload to every subscription of the given users.
//
// A subscription the push service reports as gone (404/410) is deleted outright:
// it will never work again, and keeping it means retrying a dead endpoint for
// every event forever. Softer failures only increment a counter, because a
// timeout or a 5xx is the push service having a bad minute, not the browser
// having unsubscribed.
export async function sendToUsers(userIds, payload) {
  if (!configured) return { sent: 0, failed: 0, gone: 0, skipped: 'not-configured' };
  const ids = (Array.isArray(userIds) ? userIds : []).filter((v) => v != null);
  if (!ids.length) return { sent: 0, failed: 0, gone: 0 };

  const { rows } = await query(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ANY($1::int[])`,
    [ids]
  );
  if (!rows.length) return { sent: 0, failed: 0, gone: 0 };

  const body = JSON.stringify(payload);
  let sent = 0, failed = 0, gone = 0;
  const dead = [];

  await Promise.all(rows.map(async (r) => {
    const subscription = { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } };
    try {
      await webpush.sendNotification(subscription, body, { TTL: 3600, timeout: TIMEOUT_MS });
      sent += 1;
      await query('UPDATE push_subscriptions SET last_sent_at = now(), failures = 0 WHERE id = $1', [r.id])
        .catch(() => {});
    } catch (err) {
      const status = err && (err.statusCode || err.status);
      if (status === 404 || status === 410) {
        gone += 1;
        dead.push(r.id);
        return;
      }
      failed += 1;
      console.warn(`[push] delivery to subscription ${r.id} failed (${status || 'no status'}): ${err.message}`);
      await query('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = $1', [r.id]).catch(() => {});
    }
  }));

  if (dead.length) {
    await query('DELETE FROM push_subscriptions WHERE id = ANY($1::bigint[])', [dead]).catch(() => {});
  }
  return { sent, failed, gone };
}

// The candidate accounts for an event: every non-client account that is not
// archived, with the scope and preferences the routing rules need. Read per event
// rather than cached — a role change or an opt-out has to take effect at once,
// the same reasoning as loadViewer in changehub and userScope here.
async function candidateUsers() {
  const { rows } = await query(
    `SELECT id, email, role, name, projects, archived, notify_prefs
       FROM users
      WHERE archived = false AND role <> 'client'`
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    projects: Array.isArray(r.projects) ? r.projects.map(String) : [],
    archived: !!r.archived,
    notifyPrefs: r.notify_prefs && typeof r.notify_prefs === 'object' ? r.notify_prefs : {},
  }));
}

// Push one event to whoever the rules say should be interrupted by it.
//
// Best-effort and never awaited by the caller that matters: a notification is a
// side effect of an action that has already succeeded, so a push service being
// slow must not turn a saved deployment into a failed request. Errors are logged,
// never propagated — the same contract as the office lookup in trackerService.
export async function notifyEvent({ eventKey, projectKey, actorEmail, subject, text, deploymentId, packageId } = {}) {
  if (!configured) return { sent: 0, skipped: 'not-configured' };
  try {
    const users = await candidateUsers();
    const targets = selectPushUsers({ eventKey, projectKey, actorEmail, users });
    if (!targets.length) return { sent: 0, targets: 0 };
    // Where the click lands. A deployment has a hash route already used by every
    // other channel's "open in RollDesk" link; a package has no deep link yet, so
    // it opens the app and the reader takes it from the packages list.
    const url = deploymentId
      ? deploymentUrl(config.appBaseUrl, deploymentId)
      : (config.appBaseUrl || '');
    const payload = notificationPayload({ eventKey, subject, text, url, deploymentId, packageId });
    const result = await sendToUsers(targets.map((u) => u.id), payload);
    return Object.assign({ targets: targets.length }, result);
  } catch (err) {
    console.warn(`[push] notifyEvent(${eventKey}) failed: ${err.message}`);
    return { sent: 0, error: err.message };
  }
}

// --- preferences ------------------------------------------------------------

// The role as stored, not as the caller's token remembers it. A session JWT holds
// the role from sign-in, so an account moved from tester to release manager would
// keep being offered the wrong defaults until the next login.
export async function effectiveRole(userId) {
  const { rows } = await query('SELECT role FROM users WHERE id = $1', [userId]);
  return (rows[0] && rows[0].role) || '';
}

export async function getPrefs(userId) {
  const { rows } = await query('SELECT notify_prefs FROM users WHERE id = $1', [userId]);
  const p = rows[0] && rows[0].notify_prefs;
  return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
}

// Store the toggles the user actually set. Only known event keys are kept, and
// only real booleans — an unknown key would sit in the JSONB forever with nothing
// reading it, and a non-boolean would be read as "not an opt-in" anyway.
export async function setPrefs(userId, prefs, allowedKeys) {
  const incoming = prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? prefs : {};
  const clean = {};
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(incoming, key) && typeof incoming[key] === 'boolean') {
      clean[key] = incoming[key];
    }
  }
  await query('UPDATE users SET notify_prefs = $2 WHERE id = $1', [userId, clean]);
  return clean;
}
