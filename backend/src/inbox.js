// The in-app notification inbox — the thin I/O wrapper around the routing rules
// in inboxTargets.js, the same split as push.js over pushTargets.js.
//
// Nothing here composes a sentence. The subject and body arrive already written by
// the browser that triggered the event, in the instance's notification language
// (NOTIFY_LANG), exactly as the webhook, e-mail and push channels receive them —
// which is why one event reads the same wherever it is read.
import { query } from './db.js';
import { candidateUsers } from './push.js';
import { selectInboxUsers, inboxRecord } from './inboxTargets.js';

// How long a filed notification is kept. The inbox answers "what happened while I
// was away", not "what happened in March" — that is the audit log, which is
// append-only and never pruned. Without a limit this table grows for the lifetime
// of the instance while nobody ever scrolls past the first screen of it.
const KEEP_DAYS = 90;

// How many rows the drawer asks for. Long enough that scrolling back a couple of
// weeks works, short enough that the response stays small on a slow connection.
const PAGE = 60;

// File one event for whoever the rules say has an interest in it.
//
// Awaited by the notify route, unlike the push: this is a single INSERT against
// the local database, and its count is what the sender is told ("recorded for 4
// people"). It still never throws — a notification is a side effect of an action
// that has already succeeded, so a failure here is logged and swallowed.
export async function recordEvent({ eventKey, projectKey, actorEmail, subject, text, deploymentId, packageId } = {}) {
  try {
    const users = await candidateUsers();
    const targets = selectInboxUsers({ eventKey, projectKey, actorEmail, users });
    if (!targets.length) return { stored: 0, targets: 0 };
    const row = inboxRecord({ eventKey, subject, text, projectKey, deploymentId, packageId, actorEmail });
    // One statement for every recipient. unnest() over the id array keeps this a
    // single round trip whatever the size of the team.
    const { rowCount } = await query(
      `INSERT INTO notifications
         (user_id, event, subject, body, project_key, deployment_id, package_id, actor_email)
       SELECT u, $2, $3, $4, NULLIF($5,''), NULLIF($6,''), NULLIF($7,''), NULLIF($8,'')
         FROM unnest($1::int[]) AS u`,
      [
        targets.map((u) => u.id),
        row.event, row.subject, row.body,
        row.projectKey, row.deploymentId, row.packageId, row.actorEmail,
      ]
    );
    // Best-effort housekeeping, never awaited: the sweep is cheap (an indexed
    // range delete) and this is the only moment the table is written, so it is
    // the natural place to hang it without a scheduler.
    pruneOld().catch(() => {});
    return { stored: rowCount, targets: targets.length };
  } catch (err) {
    console.warn(`[inbox] recordEvent(${eventKey}) failed: ${err.message}`);
    return { stored: 0, error: err.message };
  }
}

// One person's notifications, newest first, with the unread ones marked.
export async function listFor(userId, limit = PAGE) {
  const n = Math.min(Math.max(parseInt(limit, 10) || PAGE, 1), 200);
  // The actor's display name comes along: the address is what is stored (it is the
  // stable identity), but „Zatwierdził(a): pm@dxc.test" is not what anybody wants to
  // read on a card. A left join, so an event caused by an account since deleted still
  // lists — with the address it was recorded under.
  const { rows } = await query(
    `SELECT n.id, n.event, n.subject, n.body, n.project_key, n.deployment_id, n.package_id,
            n.actor_email, u.name AS actor_name, n.read_at, n.created_at
       FROM notifications n
       LEFT JOIN users u ON lower(u.email) = lower(n.actor_email)
      WHERE n.user_id = $1
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT $2`,
    [userId, n]
  );
  return rows.map((r) => ({
    id: String(r.id),
    event: r.event || '',
    subject: r.subject || '',
    body: r.body || '',
    projectKey: r.project_key || '',
    deploymentId: r.deployment_id || '',
    packageId: r.package_id || '',
    actorEmail: r.actor_email || '',
    actorName: r.actor_name || '',
    read: !!r.read_at,
    at: r.created_at,
  }));
}

// The badge. Its own query rather than a count over the list: every open tab asks
// for this on a timer, and it must not depend on how much history was fetched.
export async function unreadCountFor(userId) {
  const { rows } = await query(
    'SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL',
    [userId]
  );
  return (rows[0] && rows[0].n) || 0;
}

// Mark some of this person's notifications read — or unread again. Always scoped to
// the owner: an id from somebody else's drawer must not be markable from here.
//
// Both directions, because reading a notification and dealing with it are different
// things: „I have seen this, clear it" is the common case, and „put it back, I am not
// done with it" is what makes the first one safe to press.
export async function setRead(userId, ids, read = true) {
  const list = (Array.isArray(ids) ? ids : []).map((v) => String(v)).filter((v) => /^\d+$/.test(v));
  if (!list.length) return 0;
  const { rowCount } = await query(
    read
      ? `UPDATE notifications SET read_at = now()
          WHERE user_id = $1 AND read_at IS NULL AND id = ANY($2::bigint[])`
      : `UPDATE notifications SET read_at = NULL
          WHERE user_id = $1 AND read_at IS NOT NULL AND id = ANY($2::bigint[])`,
    [userId, list]
  );
  return rowCount;
}

export async function markRead(userId, ids) {
  return setRead(userId, ids, true);
}

export async function markAllRead(userId) {
  const { rowCount } = await query(
    'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL',
    [userId]
  );
  return rowCount;
}

// Retention sweep. Deletes by age for everybody at once — a per-user cap would
// need a window function and would still leave the table growing with the team.
export async function pruneOld(days = KEEP_DAYS) {
  const d = Math.max(parseInt(days, 10) || KEEP_DAYS, 1);
  const { rowCount } = await query(
    `DELETE FROM notifications WHERE created_at < now() - ($1 || ' days')::interval`,
    [String(d)]
  );
  return rowCount;
}
