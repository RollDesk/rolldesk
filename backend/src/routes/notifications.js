// Notification endpoints.
//   POST /api/notifications/test         — send a one-off test to a single webhook/e-mail.
//   POST /api/notifications/notify       — deliver a real event notification to a set of
//                                          webhooks and/or e-mail addresses at once.
//   GET  /api/notifications              — my own inbox (the bell drawer).
//   GET  /api/notifications/unread-count — the badge.
//   POST /api/notifications/read         — mark mine read or unread again
//                                          ({ ids }, { ids, read: false } or { all: true }).
// Sending happens server-side so there are no browser CORS issues, and the caller
// always learns per-recipient whether delivery succeeded or failed.
//
// The three inbox routes are the in-app record of the same events: every dispatch
// files a row per interested recipient (inbox.js), so „what happened while I was
// away" has an answer inside RollDesk and not only in a Teams channel.
import { Router } from 'express';
import { sendMail } from '../mailer.js';
import { config } from '../config.js';
import { forbidClient } from '../rbac.js';
import * as teamsGraph from '../teamsGraph.js';
import {
  appLinkSlack, appLinkCardAction, bodyToCardText, hasAppLink, deploymentUrl,
  linkLabelSlack, linkLabelMarkdown, foldSubjectIntoLead, mailBodyParts,
} from '../appLink.js';
import { clientMailAudience } from '../clientMail.js';
import { normalizeMailFooter } from '../projectMail.js';
import { renderMailHtml } from '../mailHtml.js';
import { notifyEvent as pushEvent, pushConfigured } from '../push.js';
import { isPushEvent } from '../pushTargets.js';
import { recordEvent, listFor, unreadCountFor, setRead, markAllRead } from '../inbox.js';

const router = Router();

// Sending notifications is a team action — never available to client accounts.
// The inbox below is the same: the routing files nothing for a client account, so
// the drawer would be permanently empty and the bell is hidden in the UI.
router.use(forbidClient);

// Whose inbox. From the session (or the token's owner), never from the body — an
// account may only read and clear its own notifications.
function userId(req) {
  return req.auth && req.auth.sub;
}

const TEST_TEXT =
  'This is a test message from RollDesk. If you can see it, the notification target is configured correctly.';

// Public app URL (if configured) so notifications can link back to RollDesk.
// One value per instance — it is also the SSO callback and the base of
// invitation links, so a notification cannot vary it per recipient. The
// per-channel markup lives in appLink.js so every channel agrees.
const APP_URL = config.appBaseUrl;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Recognise a Microsoft Teams Incoming Webhook by host, so we can let the Graph
// integration take over the Teams channel while leaving other webhooks intact.
function isTeamsWebhook(url) {
  try {
    const h = new URL(String(url)).hostname.toLowerCase();
    return /(^|\.)office\.com$/.test(h) || /(^|\.)office365\.com$/.test(h) ||
      /webhook\.office\.com$/.test(h) || /(^|\.)microsoft\.com$/.test(h) ||
      /logic\.azure\.com$/.test(h);
  } catch { return false; }
}

// POST a JSON body to a webhook with a bounded timeout.
async function postWebhook(url, payload, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await r.text().catch(() => '');
    return { ok: r.ok, status: r.status, text };
  } finally {
    clearTimeout(timer);
  }
}

// Build the correct payload for the target. Slack incoming webhooks expect a
// simple { text }; Teams incoming webhooks expect a MessageCard. Sending the
// wrong shape makes the target reject the request (e.g. Slack returns HTTP 400
// "invalid_payload"), so the format is chosen from the host.
// `deploymentId`, when given, is linked in place: the id already sits at the top
// of every body, so the reader clicks the thing they recognise and the message
// needs no trailing "open the app" line at all. Only when there is no id (or no
// APP_BASE_URL) does the generic link come back.
//
// A chat channel also folds the event onto that first line rather than stacking
// it above the body as a separate heading — see foldSubjectIntoLead(). When the
// fold succeeds the channel's own title is dropped, so the event appears once,
// on the line whose id is the link.
function buildWebhookPayload(url, title, text, deploymentId) {
  const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  const isSlack = /(^|\.)slack\.com$/i.test(host);
  const depUrl = deploymentUrl(APP_URL, deploymentId);
  // Schedule notifications may still carry a labelled link built by an older UI;
  // adding the generic one would put two links in the same message.
  const ownLink = !!depUrl || hasAppLink(text, APP_URL);
  const folded = foldSubjectIntoLead(text, title, deploymentId);
  const body = folded || text;
  if (isSlack) {
    const slackBody = depUrl ? linkLabelSlack(body, deploymentId, depUrl) : body;
    const message = folded ? slackBody : `${title}\n${slackBody}`;
    return { text: message + (ownLink ? '' : appLinkSlack(APP_URL)) };
  }
  const linked = depUrl ? linkLabelMarkdown(body, deploymentId, depUrl) : body;
  const payload = {
    '@type': 'MessageCard',
    '@context': 'http://schema.org/extensions',
    themeColor: '0A6E7A',
    // `summary` is the notification preview, shown instead of the card rather
    // than beside it, so it keeps the full subject either way.
    summary: title,
    text: bodyToCardText(linked),
  };
  if (!folded) payload.title = title;
  // The card action is a button, not part of the body, so it is worth keeping
  // even when the body mentions the URL — but not when the id is already a link
  // to the same place, which would read as the same link twice.
  const action = ownLink ? null : appLinkCardAction(APP_URL);
  if (action) payload.potentialAction = [action];
  return payload;
}

// Deliver to one webhook. Never throws — returns a normalised result.
//
// Logged, both ways. „The comment never showed up in the Teams channel" was
// unanswerable: the browser got a toast that whoever pressed the button may not have
// read, and the server kept no trace at all — so a webhook that had started
// rejecting one kind of message looked exactly like a webhook nobody had triggered.
// The host is logged rather than the URL: these URLs carry their own signature.
function webhookHost(url) {
  try { return new URL(String(url)).hostname; } catch { return 'unparseable-url'; }
}

async function deliverWebhook(url, title, text, deploymentId) {
  const host = webhookHost(url);
  try {
    const r = await postWebhook(url, buildWebhookPayload(url, title, text, deploymentId));
    if (!r.ok) {
      // The body is where a flow explains itself („the request schema does not
      // match", „flow is turned off"), and it is the whole reason this is logged.
      console.warn(`[notify] webhook ${host} rejected "${title}" — HTTP ${r.status}: ${(r.text || '').slice(0, 300)}`);
      return { ok: false, status: r.status, error: 'HTTP ' + r.status, detail: (r.text || '').slice(0, 300) };
    }
    console.log(`[notify] webhook ${host} accepted "${title}" (HTTP ${r.status})`);
    return { ok: true, status: r.status };
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'request timed out' : err.message;
    console.warn(`[notify] webhook ${host} failed for "${title}": ${msg}`);
    return { ok: false, error: msg };
  }
}

// Deliver one e-mail. Never throws — returns a normalised result.
//
// `to` is one address or a list of them; `cc`, `replyTo` and `footer` are used only
// by the client-facing approval request, which is one message to a whole audience
// rather than the per-recipient sends every other event does (see clientMail.js),
// and the only one signed off by a person.
async function deliverEmail({ to, cc, replyTo, subject, text, deploymentId, footer, blocks }) {
  try {
    const depUrl = deploymentUrl(APP_URL, deploymentId);
    const link = depUrl ? { label: deploymentId, url: depUrl } : null;
    // Message, then the link back to the app, then the signature — the order lives
    // in appLink.js, where it is unit-tested (mailBodyParts).
    const parts = mailBodyParts({ text, footer, link, appUrl: APP_URL });
    // A caller that sent blocks gets a laid-out HTML part (mailHtml.js); everything
    // else keeps the body-in-a-paragraph it has always had. The plain-text part is
    // the same either way, so a text-only client loses the layout and nothing else.
    const rich = renderMailHtml({ blocks, footer, link, appUrl: APP_URL });
    const result = await sendMail({
      to,
      cc,
      replyTo,
      subject,
      text: parts.text,
      html: rich || parts.html,
    });
    if (result.skipped) return { ok: false, error: 'E-mail sending is disabled (SMTP_HOST not set)' };
    return { ok: true, messageId: result.messageId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// POST /api/notifications/test — { channel: 'teams', url } | { channel: 'email', address }
router.post('/test', async (req, res) => {
  const b = req.body || {};

  if (b.channel === 'teams') {
    const url = String(b.url || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      return res.status(422).json({ error: 'A valid webhook URL (http/https) is required' });
    }
    const r = await deliverWebhook(url, 'RollDesk - test notification', TEST_TEXT);
    if (!r.ok) return res.status(502).json({ error: r.error || 'Could not reach the webhook', detail: r.detail });
    return res.json({ ok: true, status: r.status });
  }

  if (b.channel === 'email') {
    const to = String(b.address || '').trim();
    if (!EMAIL_RE.test(to)) {
      return res.status(422).json({ error: 'A valid e-mail address is required' });
    }
    const r = await deliverEmail({ to, subject: 'RollDesk - test notification', text: TEST_TEXT });
    if (!r.ok) {
      const status = /disabled/.test(r.error || '') ? 503 : 502;
      return res.status(status).json({ error: r.error || 'Could not send the e-mail' });
    }
    return res.json({ ok: true, messageId: r.messageId });
  }

  return res.status(422).json({ error: 'Unknown channel (expected "teams" or "email")' });
});

// POST /api/notifications/notify — deliver a real event notification.
// Body: { subject, text, emails: string[], webhooks: (string | {url,name})[],
//         cc: string[], groupEmail: boolean, footer: string, blocks: object[] }
// `groupEmail` sends one message to every address in `emails`, copying `cc` and
// setting Reply-To to it — the shape the client's approval request needs. `footer`
// signs that message off, under the link back to the app, and `blocks` is the same
// message as a laid-out HTML part (see mailHtml.js) — the plain text stays the
// authoritative copy either way.
// Responds with a per-recipient breakdown so the UI can report partial failures.
router.post('/notify', async (req, res) => {
  const b = req.body || {};
  const subject = String(b.subject || 'RollDesk notification').slice(0, 300);
  const text = String(b.text || '').slice(0, 4000);
  if (!text.trim()) return res.status(422).json({ error: 'A non-empty message text is required' });

  const emails = Array.isArray(b.emails) ? b.emails : [];
  let webhooks = Array.isArray(b.webhooks) ? b.webhooks : [];
  const deploymentId = b.deploymentId != null ? String(b.deploymentId) : '';
  // One message to the whole audience instead of one per address, with a copy
  // list and a Reply-To. Asked for explicitly by the caller because it changes
  // what the recipients see: they are on a thread with each other, which is right
  // for a document a client is expected to answer and wrong for the per-mailbox
  // events (a project's post-installation address does not need to know who else
  // was told). Absent, this route behaves exactly as it did.
  const grouped = b.groupEmail === true;
  // The signature of a client-facing mail, composed by the caller from the project's
  // own setting. Its own field rather than part of `text` because it has to land
  // *under* the link back to the app, and only this route knows where that link
  // goes (mailBodyParts). Bounded and stripped the same way it is when stored
  // (projectMail.js), and deliberately not filed in the inbox or pushed: a sign-off
  // in the bell drawer is noise.
  const footer = normalizeMailFooter(b.footer);
  const audience = grouped
    ? clientMailAudience({ to: emails, cc: b.cc })
    : { to: [], cc: [], replyTo: [], invalid: [] };

  // Browser notifications ride on the same event, with the body the browser has
  // already composed in the instance's notification language — which is why this
  // needed no server-side composer. Who gets interrupted is decided server-side
  // (role, project scope, per-user preference) because that is an authorization
  // question, and the actor comes from the session rather than the body so a
  // caller cannot suppress or redirect somebody else's notification.
  //
  // Deliberately not awaited: a notification is a side effect of an action that
  // has already succeeded, so a slow push service must not turn a saved
  // deployment into a failed request. pushEvent logs its own failures.
  pushEvent({
    eventKey: b.eventKey,
    projectKey: b.projectKey,
    actorEmail: (req.auth && req.auth.email) || '',
    subject,
    text,
    deploymentId,
    packageId: b.packageId != null ? String(b.packageId) : '',
  }).catch(() => {});

  // The in-app record, for everyone the event concerns — including the people who
  // muted its push and the events no push exists for (see inboxTargets.js). Awaited
  // rather than fired off, unlike the push: it is one local INSERT, and the count
  // is part of what the sender is told, so an event that reached nobody through a
  // webhook can still report that it was filed. recordEvent never throws.
  const inbox = await recordEvent({
    eventKey: b.eventKey,
    projectKey: b.projectKey,
    actorEmail: (req.auth && req.auth.email) || '',
    subject,
    text,
    deploymentId,
    packageId: b.packageId != null ? String(b.packageId) : '',
  });

  const jobs = [];

  // Microsoft Teams via Graph: when configured, post to the channel and thread
  // per deployment. It replaces the per-client *Teams* webhooks (to avoid double
  // messages), but non-Teams webhooks (e.g. Slack) and e-mails still go out. If
  // the Graph post fails (e.g. app-only send is blocked by the tenant), we fall
  // back to delivering the Teams webhooks as before.
  let graphResult = null;
  if (teamsGraph.canPost()) {
    const teamsWebhooks = webhooks.filter((w) => isTeamsWebhook((w && w.url) || w));
    const otherWebhooks = webhooks.filter((w) => !isTeamsWebhook((w && w.url) || w));
    graphResult = await teamsGraph.postDeploymentEvent({ deploymentId, subject, text });
    if (graphResult.ok) {
      // Graph handled the Teams side — only keep the non-Teams webhooks.
      webhooks = otherWebhooks;
      jobs.push(Promise.resolve({ type: 'teams-graph', target: 'Teams channel', ok: true, threaded: !!graphResult.threaded }));
    } else if (!graphResult.skipped) {
      // Configured but the send failed — keep the Teams webhooks as a fallback
      // and surface the Graph error in the results.
      jobs.push(Promise.resolve({ type: 'teams-graph', target: 'Teams channel', ok: false, error: graphResult.error, status: graphResult.status }));
    }
  }
  if (grouped) {
    // A rejected address is reported rather than dropped: an address quietly
    // missing from a mail the client is expected to answer is worse than an error,
    // because nobody finds out until the answer never comes.
    for (const bad of audience.invalid) {
      jobs.push(Promise.resolve({ type: 'email', target: bad, ok: false, error: 'invalid e-mail address' }));
    }
    if (audience.to.length) {
      const target = audience.to.join(', ') + (audience.cc.length ? ` (cc: ${audience.cc.join(', ')})` : '');
      jobs.push(
        deliverEmail({ to: audience.to, cc: audience.cc, replyTo: audience.replyTo, subject, text,
          deploymentId, footer, blocks: Array.isArray(b.blocks) ? b.blocks : null })
          .then((r) => ({ type: 'email', target, recipients: audience.to.length + audience.cc.length, ...r }))
      );
    }
  } else {
    for (const raw of emails) {
      const to = String(raw || '').trim();
      if (!EMAIL_RE.test(to)) { jobs.push(Promise.resolve({ type: 'email', target: to, ok: false, error: 'invalid e-mail address' })); continue; }
      jobs.push(deliverEmail({ to, subject, text, deploymentId }).then((r) => ({ type: 'email', target: to, ...r })));
    }
  }
  for (const raw of webhooks) {
    const url = String((raw && raw.url) || raw || '').trim();
    const name = (raw && raw.name) || url;
    if (!/^https?:\/\//i.test(url)) { jobs.push(Promise.resolve({ type: 'webhook', target: name, ok: false, error: 'invalid webhook URL' })); continue; }
    jobs.push(deliverWebhook(url, subject, text, deploymentId).then((r) => ({ type: 'webhook', target: name, ...r })));
  }

  // A project with no webhook and no e-mail on file is now a normal state rather
  // than a mistake: the event may still have reached people as a browser
  // notification or as a row in their inbox, and reporting that as a failure would
  // put a red toast on a perfectly delivered event.
  if (!jobs.length) {
    if (inbox.stored || (isPushEvent(b.eventKey) && pushConfigured())) {
      return res.json({ ok: true, sent: 0, failed: 0, results: [], push: true, inbox: inbox.stored || 0 });
    }
    return res.status(422).json({ error: 'No recipients (emails/webhooks) provided' });
  }

  const results = await Promise.all(jobs);
  const failed = results.filter((r) => !r.ok);
  // 207-style summary: overall ok only when every recipient succeeded.
  return res.status(failed.length ? 502 : 200).json({
    ok: failed.length === 0,
    sent: results.length - failed.length,
    failed: failed.length,
    inbox: inbox.stored || 0,
    results,
  });
});

// ---- The inbox (bell drawer) ----------------------------------------------
//
// Always the caller's own. There is deliberately no "everybody's notifications"
// view: the routing already decides who may be told what, and a shared feed would
// be the one place that hands a deployer the projects they were not granted.

// GET /api/notifications?limit=60 — newest first, with the badge in the same call
// so opening the drawer is one request.
router.get('/', async (req, res) => {
  const id = userId(req);
  const notifications = await listFor(id, req.query.limit);
  res.json({ notifications, unread: await unreadCountFor(id) });
});

// GET /api/notifications/unread-count — polled by every open tab.
router.get('/unread-count', async (req, res) => {
  res.json({ unread: await unreadCountFor(userId(req)) });
});

// POST /api/notifications/read — { ids: [...] } to clear them, { ids, read: false } to
// put them back, { all: true } to clear the lot.
router.post('/read', async (req, res) => {
  const id = userId(req);
  const b = req.body || {};
  const marked = b.all === true
    ? await markAllRead(id)
    : await setRead(id, b.ids, b.read !== false);
  res.json({ marked, unread: await unreadCountFor(id) });
});

export default router;
