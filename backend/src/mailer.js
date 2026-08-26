import nodemailer from 'nodemailer';
import { config } from './config.js';

let transporter = null;
function getTransporter() {
  if (!config.smtp.host) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
      tls: { rejectUnauthorized: config.smtp.tlsRejectUnauthorized },
    });
  }
  return transporter;
}

// `to` may be one address or a list. `cc` and `replyTo` exist for the one message
// RollDesk sends that a human is expected to answer — the request for a client's
// approval, where the DXC side is copied and the reply has to reach the service
// mailbox rather than the no-reply `from` (see clientMail.js). Both are omitted
// from the message entirely when empty, so every other caller sends exactly the
// headers it did before.
// `attachments` is nodemailer's own shape ({ filename, content, contentType }) and
// exists for the one mail that carries a document: the client's approval request,
// which attaches the rollout schedule as a PDF (schedulePdf.js). Omitted when empty,
// so every other caller sends exactly the message it did before.
export async function sendMail({ to, cc, subject, text, html, replyTo, attachments }) {
  const t = getTransporter();
  if (!t) {
    console.warn('[mailer] Sending skipped — SMTP_HOST not set.');
    return { skipped: true };
  }
  const list = (v) => (Array.isArray(v) ? v.filter(Boolean) : (v ? [v] : []));
  const ccList = list(cc);
  const replyList = list(replyTo);
  const files = Array.isArray(attachments) ? attachments.filter(Boolean) : [];
  const info = await t.sendMail({
    from: config.smtp.from,
    to,
    cc: ccList.length ? ccList : undefined,
    replyTo: replyList.length ? replyList.join(', ') : undefined,
    subject,
    text,
    html,
    attachments: files.length ? files : undefined,
  });
  return { messageId: info.messageId };
}
