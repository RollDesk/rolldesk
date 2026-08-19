// Browser-notification endpoints. Mounted at /api/push.
//
//   GET    /api/push/config      — the VAPID public key, and what this account's
//                                  defaults are, so the settings view can render
//   POST   /api/push/subscribe   — register this browser
//   DELETE /api/push/subscribe   — deregister this browser
//   PUT    /api/push/prefs       — which events I want pushed
//   POST   /api/push/test        — send a test to my own devices
//
// Behind `requireAuth` (a session JWT), never `requireApiAuth`: these manage a
// person's own browsers, and an `rd_live_…` automation token has no business
// subscribing or unsubscribing anyone's devices — the same reasoning that keeps
// token management off API-token auth.
//
// Client accounts are refused outright. The routing rules already exclude them
// (pushTargets.js), so a client subscription could never receive anything; storing
// one would only be a row that never fires.
import { Router } from 'express';
import { isClient } from '../rbac.js';
import { PUSH_EVENTS, defaultEventsForRole, notificationPayload } from '../pushTargets.js';
import {
  pushConfigured, publicKey, saveSubscription, deleteSubscription,
  listSubscriptions, getPrefs, setPrefs, sendToUsers, effectiveRole,
} from '../push.js';
import { config } from '../config.js';

const router = Router();

router.use((req, res, next) => {
  if (isClient(req)) return res.status(403).json({ error: 'Not available for client accounts' });
  next();
});

function userId(req) {
  return req.auth && req.auth.sub;
}

// What the settings view needs in one call: whether the instance can push at all,
// the key to subscribe with, the event list, this role's defaults, and the
// browsers already registered.
router.get('/config', async (req, res) => {
  const id = userId(req);
  // From the database, not from the token: the JWT carries the role held at
  // sign-in, and a reassignment has to change the defaults shown here at once —
  // the same reason the routing itself reads the role per event.
  const role = (await effectiveRole(id)) || (req.auth && req.auth.role) || '';
  res.json({
    configured: pushConfigured(),
    publicKey: publicKey(),
    events: PUSH_EVENTS,
    defaults: defaultEventsForRole(role),
    prefs: await getPrefs(id),
    devices: pushConfigured() ? await listSubscriptions(id) : [],
  });
});

router.post('/subscribe', async (req, res) => {
  if (!pushConfigured()) return res.status(503).json({ error: 'Browser notifications are not configured on this instance' });
  const result = await saveSubscription(userId(req), req.body && req.body.subscription, req.get('user-agent'));
  if (!result.ok) return res.status(422).json({ error: result.error });
  res.json({ ok: true, devices: await listSubscriptions(userId(req)) });
});

router.delete('/subscribe', async (req, res) => {
  const endpoint = (req.body && req.body.endpoint) || req.query.endpoint || '';
  if (!endpoint) return res.status(422).json({ error: 'endpoint is required' });
  const removed = await deleteSubscription(userId(req), endpoint);
  res.json({ removed, devices: await listSubscriptions(userId(req)) });
});

router.put('/prefs', async (req, res) => {
  const saved = await setPrefs(userId(req), req.body && req.body.prefs, PUSH_EVENTS);
  res.json({ prefs: saved });
});

// A test to my own browsers. Worth an endpoint of its own: "I turned it on and
// nothing happens" is the first support question about any notification channel,
// and the answer is usually the operating system's own do-not-disturb rather than
// anything in the app.
router.post('/test', async (req, res) => {
  if (!pushConfigured()) return res.status(503).json({ error: 'Browser notifications are not configured on this instance' });
  const payload = notificationPayload({
    eventKey: 'test',
    subject: 'RollDesk',
    text: 'Test notification — browser notifications are working on this device.',
    url: config.appBaseUrl || '',
  });
  const result = await sendToUsers([userId(req)], payload);
  res.json(result);
});

export default router;
