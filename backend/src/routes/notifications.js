// Notification test endpoint — lets an admin send a one-off test message to a
// Teams incoming webhook (server-side, so there are no browser CORS issues) or
// to an e-mail address via the configured SMTP transport.
import { Router } from 'express';
import { sendMail } from '../mailer.js';
import { config } from '../config.js';

const router = Router();

const TEST_TEXT =
  'This is a test message from RollDesk. If you can see it, the notification target is configured correctly.';

// Public app URL (if configured) so notifications can link back to RollDesk.
const APP_URL = config.appBaseUrl;

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

// POST /api/notifications/test — { channel: 'teams', url } | { channel: 'email', address }
router.post('/test', async (req, res) => {
  const b = req.body || {};

  if (b.channel === 'teams') {
    const url = String(b.url || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      return res.status(422).json({ error: 'A valid webhook URL (http/https) is required' });
    }
    // The payload shape depends on the target: Slack incoming webhooks expect a
    // simple { text }, while Teams incoming webhooks expect a MessageCard.
    // Sending the wrong shape makes the target reject the request (e.g. Slack
    // returns HTTP 400 "invalid_payload"), so pick the format from the host.
    const isSlack = /(^|\.)slack\.com$/i.test((() => { try { return new URL(url).hostname; } catch { return ''; } })());
    let payload;
    if (isSlack) {
      // Slack renders <url|label> as a link inside the message text.
      payload = {
        text: 'RollDesk — test notification\n' + TEST_TEXT +
          (APP_URL ? `\n<${APP_URL}|Open RollDesk>` : ''),
      };
    } else {
      payload = {
        '@type': 'MessageCard',
        '@context': 'http://schema.org/extensions',
        themeColor: '0A6E7A',
        summary: 'RollDesk test notification',
        title: 'RollDesk — test notification',
        text: TEST_TEXT,
      };
      // Teams MessageCard shows an "Open RollDesk" button when a URL is configured.
      if (APP_URL) {
        payload.potentialAction = [{
          '@type': 'OpenUri',
          name: 'Open RollDesk',
          targets: [{ os: 'default', uri: APP_URL }],
        }];
      }
    }
    try {
      const r = await postWebhook(url, payload);
      if (!r.ok) return res.status(502).json({ error: 'Webhook returned HTTP ' + r.status, detail: (r.text || '').slice(0, 300) });
      return res.json({ ok: true, status: r.status });
    } catch (err) {
      const detail = err.name === 'AbortError' ? 'request timed out' : err.message;
      return res.status(502).json({ error: 'Could not reach the webhook', detail });
    }
  }

  if (b.channel === 'email') {
    const to = String(b.address || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return res.status(422).json({ error: 'A valid e-mail address is required' });
    }
    try {
      const linkText = APP_URL ? `\n\nOpen RollDesk: ${APP_URL}` : '';
      const linkHtml = APP_URL ? `<p><a href="${APP_URL}">Open RollDesk</a></p>` : '';
      const result = await sendMail({
        to,
        subject: 'RollDesk — test notification',
        text: TEST_TEXT + linkText,
        html: `<p>${TEST_TEXT}</p>${linkHtml}`,
      });
      if (result.skipped) return res.status(503).json({ error: 'E-mail sending is disabled (SMTP_HOST not set)' });
      return res.json({ ok: true, messageId: result.messageId });
    } catch (err) {
      return res.status(502).json({ error: 'Could not send the e-mail', detail: err.message });
    }
  }

  return res.status(422).json({ error: 'Unknown channel (expected "teams" or "email")' });
});

export default router;
