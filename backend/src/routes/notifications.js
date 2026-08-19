// Notification endpoints.
//   POST /api/notifications/test   — send a one-off test to a single webhook/e-mail.
//   POST /api/notifications/notify — deliver a real event notification to a set of
//                                    webhooks and/or e-mail addresses at once.
// Sending happens server-side so there are no browser CORS issues, and the caller
// always learns per-recipient whether delivery succeeded or failed.
import { Router } from 'express';
import { sendMail } from '../mailer.js';
import { config } from '../config.js';
import { forbidClient } from '../rbac.js';
import * as teamsGraph from '../teamsGraph.js';
import {
  appLinkText, appLinkHtml, appLinkSlack, appLinkCardAction, bodyToHtml,
  bodyToCardText, hasAppLink, deploymentUrl, linkLabelSlack, linkLabelMarkdown,
  foldSubjectIntoLead,
} from '../appLink.js';
import { notifyEvent as pushEvent, pushConfigured } from '../push.js';
import { isPushEvent } from '../pushTargets.js';

const router = Router();

// Sending notifications is a team action — never available to client accounts.
router.use(forbidClient);

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
async function deliverWebhook(url, title, text, deploymentId) {
  try {
    const r = await postWebhook(url, buildWebhookPayload(url, title, text, deploymentId));
    if (!r.ok) return { ok: false, status: r.status, error: 'HTTP ' + r.status, detail: (r.text || '').slice(0, 300) };
    return { ok: true, status: r.status };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'request timed out' : err.message };
  }
}

// Deliver to one e-mail address. Never throws — returns a normalised result.
async function deliverEmail(to, subject, text, deploymentId) {
  try {
    const depUrl = deploymentUrl(APP_URL, deploymentId);
    // Skip the generic link when the id is already a link, or when the body
    // links back to the app on its own.
    const ownLink = !!depUrl || hasAppLink(text, APP_URL);
    const linkText = ownLink ? '' : appLinkText(APP_URL);
    const linkHtml = ownLink ? '' : appLinkHtml(APP_URL);
    // The plain-text part cannot carry an anchor, so the deployment URL is spelled
    // out under the body rather than being lost for text-only clients.
    const textLink = depUrl ? `\n\n${depUrl}` : linkText;
    const result = await sendMail({
      to,
      subject,
      text: text + textLink,
      html: bodyToHtml(text, depUrl ? { label: deploymentId, url: depUrl } : null) + linkHtml,
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
    const r = await deliverWebhook(url, 'RollDesk — test notification', TEST_TEXT);
    if (!r.ok) return res.status(502).json({ error: r.error || 'Could not reach the webhook', detail: r.detail });
    return res.json({ ok: true, status: r.status });
  }

  if (b.channel === 'email') {
    const to = String(b.address || '').trim();
    if (!EMAIL_RE.test(to)) {
      return res.status(422).json({ error: 'A valid e-mail address is required' });
    }
    const r = await deliverEmail(to, 'RollDesk — test notification', TEST_TEXT);
    if (!r.ok) {
      const status = /disabled/.test(r.error || '') ? 503 : 502;
      return res.status(status).json({ error: r.error || 'Could not send the e-mail' });
    }
    return res.json({ ok: true, messageId: r.messageId });
  }

  return res.status(422).json({ error: 'Unknown channel (expected "teams" or "email")' });
});

// POST /api/notifications/notify — deliver a real event notification.
// Body: { subject, text, emails: string[], webhooks: (string | {url,name})[] }
// Responds with a per-recipient breakdown so the UI can report partial failures.
router.post('/notify', async (req, res) => {
  const b = req.body || {};
  const subject = String(b.subject || 'RollDesk notification').slice(0, 300);
  const text = String(b.text || '').slice(0, 4000);
  if (!text.trim()) return res.status(422).json({ error: 'A non-empty message text is required' });

  const emails = Array.isArray(b.emails) ? b.emails : [];
  let webhooks = Array.isArray(b.webhooks) ? b.webhooks : [];
  const deploymentId = b.deploymentId != null ? String(b.deploymentId) : '';

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
  for (const raw of emails) {
    const to = String(raw || '').trim();
    if (!EMAIL_RE.test(to)) { jobs.push(Promise.resolve({ type: 'email', target: to, ok: false, error: 'invalid e-mail address' })); continue; }
    jobs.push(deliverEmail(to, subject, text, deploymentId).then((r) => ({ type: 'email', target: to, ...r })));
  }
  for (const raw of webhooks) {
    const url = String((raw && raw.url) || raw || '').trim();
    const name = (raw && raw.name) || url;
    if (!/^https?:\/\//i.test(url)) { jobs.push(Promise.resolve({ type: 'webhook', target: name, ok: false, error: 'invalid webhook URL' })); continue; }
    jobs.push(deliverWebhook(url, subject, text, deploymentId).then((r) => ({ type: 'webhook', target: name, ...r })));
  }

  // A project with no webhook and no e-mail on file is now a normal state rather
  // than a mistake: the event may still have reached people as a browser
  // notification, and reporting that as a failure would put a red toast on a
  // perfectly delivered event.
  if (!jobs.length) {
    if (isPushEvent(b.eventKey) && pushConfigured()) {
      return res.json({ ok: true, sent: 0, failed: 0, results: [], push: true });
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
    results,
  });
});

export default router;
