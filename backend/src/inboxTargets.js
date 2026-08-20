// Who an in-app notification is filed for, and what the stored card holds — pure
// functions, no I/O. inbox.js does the database side, routes/notifications.js the
// HTTP side (the same split as pushTargets.js / push.js).
//
// The bell is the record, the push is the interruption. That is the whole reason
// this routing is not the push routing:
//
//   * every event in the catalogue can be filed, not just the eight worth
//     buzzing a phone about — a daily report or a corrected status is something
//     you want to *find*, not to be interrupted by;
//   * a muted event still gets filed. `notify_prefs` says "do not interrupt me",
//     which is a different sentence from "do not tell me", and reading it as the
//     latter would make the drawer lie about what happened.
//
// What it keeps from the push routing is the part that is an authorization
// question rather than a preference: role and project scope (inProjectScope), so
// the bell can never become the one channel that shows a deployer a project they
// were not granted.
import { PUSH_EVENT_ROLES, inProjectScope } from './pushTargets.js';

const str = (v) => (v == null ? '' : String(v)).trim();
const lower = (v) => str(v).toLowerCase();

// Which roles have an interest in each event of the UI catalogue
// (NOTIF_EVENT_DEFS in the frontend — 16 events).
//
// The eight events that are also pushed keep exactly the push role lists, spread
// in rather than repeated: two tables answering "who cares about a failure" is
// how they drift apart, and the pushed set is by definition a subset of the filed
// set. Everything below the spread is an event no push exists for.
//
// `client` appears nowhere, as in the push routing: a client has the portal and
// e-mail, and our operational traffic is not theirs to read.
export const INBOX_EVENT_ROLES = {
  ...PUSH_EVENT_ROLES,

  // An approval request went to the client — the release manager is now waiting
  // on an answer, and that wait is the thing they lose track of.
  approval:       ['rm', 'admin'],
  // The client wrote something on a distribution. Not urgent enough to interrupt
  // for, and exactly the kind of thing that used to be discovered a week later.
  clientComment:  ['rm', 'admin'],
  // A comment on a deployment: whoever plans it and whoever installs it.
  comment:        ['rm', 'installer', 'admin'],
  // Work actually started on production.
  started:        ['rm', 'admin'],
  // Somebody corrected an installation result. The record changed under whoever
  // is reading it, which is worth a line in the history of what happened.
  correction:     ['rm', 'admin'],
  // The day's tally. A report, in the plainest sense — filed, never pushed.
  dayReport:      ['rm', 'admin'],
  // The rollout finished, with its status. The test team cares as much as the
  // release manager: it is the release they signed off arriving on site.
  completed:      ['rm', 'tester', 'admin'],
  // A package exists. `packageReady` (handed over) is the pushed one; creating it
  // is news to the same people, quietly.
  packageCreated: ['rm', 'tester', 'admin'],
};

// The events this module knows about, in catalogue order.
export const INBOX_EVENTS = Object.keys(INBOX_EVENT_ROLES);

// Whether an event may be filed at all. The notify route passes through whatever
// the browser sent, so an unknown key must not create rows nobody can explain.
export function isInboxEvent(eventKey) {
  return Object.prototype.hasOwnProperty.call(INBOX_EVENT_ROLES, str(eventKey));
}

export function rolesForInboxEvent(eventKey) {
  return isInboxEvent(eventKey) ? INBOX_EVENT_ROLES[str(eventKey)] : [];
}

// The users one event is filed for.
//
// `users` is the candidate list as the database returns it:
//   { id, email, role, projects, archived }
// `actorEmail` is whoever caused the event. They are not filed a notification
// about their own action — the same rule as the push routing, and for the same
// reason: a drawer that opens on three lines describing what you just did is a
// drawer nobody reads the fourth line of.
//
// Deliberately *not* consulted: notify_prefs. See the header.
export function selectInboxUsers({ eventKey, projectKey, actorEmail, users } = {}) {
  const roles = rolesForInboxEvent(eventKey);
  if (!roles.length) return [];
  const actor = lower(actorEmail);
  return (Array.isArray(users) ? users : []).filter((u) => {
    if (!u || u.id == null) return false;
    if (u.archived) return false;
    if (actor && lower(u.email) === actor) return false;
    if (!roles.includes(lower(u.role))) return false;
    return inProjectScope(u, projectKey);
  });
}

// Bounds on what one card may store. The drawer shows a heading, a few lines and
// a timestamp — the notification is an invitation to open the record, not a copy
// of it — and a composed body carries a changelog that can run to pages. Filing
// the whole thing per recipient would put the same kilobytes in the table once
// per person, so it is cut here rather than at display time.
const MAX_SUBJECT = 300;
const MAX_BODY = 1200;
const MAX_REF = 120;

// The row to store, from the same fields the notify route already receives.
// Shaped here (not in the route) so the clamping is covered by a test.
export function inboxRecord({ eventKey, subject, text, projectKey, deploymentId, packageId, actorEmail } = {}) {
  return {
    event: str(eventKey).slice(0, MAX_REF),
    subject: str(subject).slice(0, MAX_SUBJECT),
    body: str(text).slice(0, MAX_BODY),
    projectKey: str(projectKey).slice(0, MAX_REF),
    deploymentId: str(deploymentId).slice(0, MAX_REF),
    packageId: str(packageId).slice(0, MAX_REF),
    actorEmail: str(actorEmail).slice(0, MAX_REF),
  };
}
