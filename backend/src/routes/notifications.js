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

const router = Router();

// Sending notifications is a team action — never available to client accounts.
router.use(forbidClient);

const TEST_TEXT =
  'This is a test message from RollDesk. If you can see it, the notification target is configured correctly.';

// Public app URL (if configured) so notifications can link back to RollDesk.
const APP_URL = config.appBaseUrl;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
function buildWebhookPayload(url, title, text) {
  const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  const isSlack = /(^|\.)slack\.com$/i.test(host);
  if (isSlack) {
    // Slack renders <url|label> as a link inside the message text.
    return {
      text: `${title}\n${text}` + (APP_URL ? `\n<${APP_URL}|Open RollDesk>` : ''),
    };
  }
  // Teams MessageCard collapses single newlines, so force a break on each line
  // (a blank line between paragraphs) to keep the detailed body readable.
  const teamsText = String(text == null ? '' : text).replace(/\n/g, '\n\n');
  const payload = {
    '@type': 'MessageCard',
    '@context': 'http://schema.org/extensions',
    themeColor: '0A6E7A',
    summary: title,
    title,
    text: teamsText,
  };
  if (APP_URL) {
    payload.potentialAction = [{
      '@type': 'OpenUri',
      name: 'Open RollDesk',
      targets: [{ os: 'default', uri: APP_URL }],
    }];
  }
  return payload;
}

// Deliver to one webhook. Never throws — returns a normalised result.
async function deliverWebhook(url, title, text) {
  try {
    const r = await postWebhook(url, buildWebhookPayload(url, title, text));
    if (!r.ok) return { ok: false, status: r.status, error: 'HTTP ' + r.status, detail: (r.text || '').slice(0, 300) };
    return { ok: true, status: r.status };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'request timed out' : err.message };
  }
}

// Deliver to one e-mail address. Never throws — returns a normalised result.
async function deliverEmail(to, subject, text) {
  try {
    const linkText = APP_URL ? `\n\nOpen RollDesk: ${APP_URL}` : '';
    const linkHtml = APP_URL ? `<p><a href="${APP_URL}">Open RollDesk</a></p>` : '';
    const result = await sendMail({
      to,
      subject,
      text: text + linkText,
      html: `<p>${text.replace(/\n/g, '<br>')}</p>${linkHtml}`,
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
  const webhooks = Array.isArray(b.webhooks) ? b.webhooks : [];

  const jobs = [];
  for (const raw of emails) {
    const to = String(raw || '').trim();
    if (!EMAIL_RE.test(to)) { jobs.push(Promise.resolve({ type: 'email', target: to, ok: false, error: 'invalid e-mail address' })); continue; }
    jobs.push(deliverEmail(to, subject, text).then((r) => ({ type: 'email', target: to, ...r })));
  }
  for (const raw of webhooks) {
    const url = String((raw && raw.url) || raw || '').trim();
    const name = (raw && raw.name) || url;
    if (!/^https?:\/\//i.test(url)) { jobs.push(Promise.resolve({ type: 'webhook', target: name, ok: false, error: 'invalid webhook URL' })); continue; }
    jobs.push(deliverWebhook(url, subject, text).then((r) => ({ type: 'webhook', target: name, ...r })));
  }

  if (!jobs.length) return res.status(422).json({ error: 'No recipients (emails/webhooks) provided' });

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
