// Who gets a browser notification, and for what — pure functions, no I/O.
//
// A browser notification interrupts. That is its value and its whole risk: a
// channel that fires for everything gets switched off at the browser, and once a
// user has blocked notifications for a site they do not come back. So the rule
// here is deliberately narrower than the webhook catalogue — an event earns a
// push only when the recipient has something to *do* about it, or when not
// knowing costs a wasted trip.
//
// The webhook/e-mail catalogue (NOTIF_EVENT_DEFS in the UI) stays as it is: 16
// events, routed per client. This module is the second, narrower routing — by
// role and project scope, to a person rather than to a channel.
//
// push.js does the delivery, routes/push.js the subscription bookkeeping.

const str = (v) => (v == null ? '' : String(v)).trim();
const lower = (v) => str(v).toLowerCase();

// Which roles are notified for which event, by default.
//
// `admin` shadows rm ∪ installer rather than getting nothing: an account holds a
// single role, so the person who administers RollDesk and also installs on site
// is an 'admin' (the same reasoning as installersForProject in the UI). Giving
// admins no notifications would mean the one account that does everything hears
// about nothing.
//
// `client` appears nowhere on purpose. A client has the portal and e-mail; our
// operational traffic is not theirs to be interrupted by.
export const PUSH_EVENT_ROLES = {
  // The two the team asked for.
  //
  // A package handed over is the *project manager's* cue: nothing can be planned
  // from it until they clear the release for deployment (see the approval gate in
  // releasePackage.js). It used to go to the release manager, who could then plan a
  // rollout from a package nobody had approved.
  packageReady:     ['pm', 'admin'],
  // ...and the clearance itself is the release manager's and the deployer's cue —
  // this is the moment the rollout can actually be planned. Without it the
  // approval would be a decision taken in RollDesk that nobody in RollDesk hears
  // about, which is the mail thread this whole gate replaces.
  packageApproved:  ['rm', 'installer', 'admin'],
  // A schedule exists, so the person who will install it can see what is coming.
  created:          ['installer', 'admin'],
  // ...and a schedule that changed after it was announced. The deployer is working
  // from what they were told the first time — a version that moved or an
  // application that joined reaches them here or not at all, and the release
  // manager needs to see a colleague's edit to a rollout they announced.
  updated:          ['rm', 'installer', 'admin'],

  // Everything below is here because it blocks work or costs a wasted trip.
  //
  // The client signed off: for the deployer this is the real "you can start"
  // moment — before it the rollout sits in "awaiting the client".
  scheduleApproved: ['rm', 'installer', 'admin'],
  // Named on a rollout: the strongest possible "this one is mine".
  assigned:         ['installer', 'admin'],
  // A date moved. Without this someone travels to a site on the wrong day, which
  // is the most expensive thing on this list to get wrong.
  scheduleChanged:  ['rm', 'installer', 'admin'],
  // Stop working on it (deployer) and decide whether to resume (release manager —
  // only they can).
  paused:           ['rm', 'installer', 'admin'],
  // A target failed: the release manager decides about replanning, the tester
  // whether the fix needs rebuilding.
  failure:          ['rm', 'tester', 'admin'],
  // The client rejected or commented on a schedule — the rollout is blocked until
  // the release manager answers.
  decision:         ['rm', 'admin'],
};

// The events this module knows about, in a stable order for the settings UI.
export const PUSH_EVENTS = Object.keys(PUSH_EVENT_ROLES);

// Whether an event is pushable at all. The notify route passes through whatever
// the browser sent, so an event outside the list above (a daily report, a
// comment) must not become a push just because someone added it upstream.
export function isPushEvent(eventKey) {
  return Object.prototype.hasOwnProperty.call(PUSH_EVENT_ROLES, str(eventKey));
}

// The events a role is expected to act on — what a user gets before they ever
// open the notification settings.
export function defaultEventsForRole(role) {
  const r = lower(role);
  return PUSH_EVENTS.filter((k) => PUSH_EVENT_ROLES[k].includes(r));
}

// Whether this user wants this event.
//
// An absent key means "the default for my role", not "off". A user who never
// touched the settings still gets what their role needs, and an event added to
// the catalogue later reaches them instead of being silently muted — the same
// rule (and the same past bug) as the per-client webhook event map.
export function wantsEvent(prefs, role, eventKey) {
  const key = str(eventKey);
  if (!isPushEvent(key)) return false;
  const p = prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? prefs : {};
  if (Object.prototype.hasOwnProperty.call(p, key)) return p[key] === true;
  return defaultEventsForRole(role).includes(key);
}

// Whether a user may be told about something in this project at all.
//
// Deployers and testers are scoped to the projects they were granted; admins and
// release managers are unscoped, exactly as everywhere else (rbac.js). A push
// must never be the one path that leaks a project name past that boundary.
export function inProjectScope(user, projectKey) {
  const role = lower(user && user.role);
  if (role === 'admin' || role === 'rm') return true;
  if (role === 'client') return false;
  const key = str(projectKey);
  if (!key) return false;
  const projects = Array.isArray(user && user.projects) ? user.projects.map(str) : [];
  return projects.includes(key);
}

// The users to push one event to.
//
// `users` is the candidate list as the database returns it:
//   { id, email, role, projects, notifyPrefs }
// `actorEmail` is whoever caused the event — they are never notified about their
// own action. Without this the release manager who marks a package ready gets a
// popup announcing it to themselves, which is how a new channel earns its
// reputation in the first five minutes.
export function selectPushUsers({ eventKey, projectKey, actorEmail, users } = {}) {
  const key = str(eventKey);
  if (!isPushEvent(key)) return [];
  const actor = lower(actorEmail);
  return (Array.isArray(users) ? users : []).filter((u) => {
    if (!u || u.id == null) return false;
    if (u.archived) return false;
    if (actor && lower(u.email) === actor) return false;
    if (!inProjectScope(u, projectKey)) return false;
    return wantsEvent(u.notifyPrefs, u.role, key);
  });
}

// Bounds so a payload cannot grow past what a push service accepts (4 kB for the
// encrypted body on most of them) and so a notification stays readable on a
// phone. The body is the first couple of lines of the composed message, not the
// whole thing — the notification is an invitation to open the record, not the
// record.
const MAX_TITLE = 120;
const MAX_BODY = 300;

// The payload a browser receives. Shaped here (not in the route) so the trimming
// is covered by a test rather than discovered on a locked phone screen.
//
// `subject` and `text` arrive already composed in the instance's notification
// language — the browser that triggered the event built them, which is why this
// module never formats a sentence of its own.
export function notificationPayload({ eventKey, subject, text, url, deploymentId, packageId } = {}) {
  const title = str(subject).slice(0, MAX_TITLE) || 'RollDesk';
  // The composed body opens with the id and the project on their own lines; two
  // lines is what a notification shows before it truncates, so send that much and
  // let the click do the rest.
  const body = str(text).split('\n').filter((l) => str(l)).slice(0, 3).join('\n').slice(0, MAX_BODY);
  return {
    title,
    body,
    // One notification per record replaces the previous one for that record
    // instead of stacking: three date changes on the same rollout are one thing
    // to look at, not three.
    tag: 'rolldesk:' + (str(deploymentId) || str(packageId) || str(eventKey) || 'event'),
    url: str(url),
    event: str(eventKey),
  };
}
