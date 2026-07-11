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
    });
  }
  return transporter;
}

export async function sendMail({ to, subject, text, html }) {
  const t = getTransporter();
  if (!t) {
    console.warn('[mailer] Sending skipped — SMTP_HOST not set.');
    return { skipped: true };
  }
  const info = await t.sendMail({ from: config.smtp.from, to, subject, text, html });
  return { messageId: info.messageId };
}
