// The HTML part of the one mail RollDesk sends to somebody outside the team: the
// client's request for approval of a production rollout.
//
// Every other notification is read in a Teams channel or by us, and for those the
// HTML part is the plain text in a single paragraph (bodyToHtml) — which is exactly
// what it looks like. The approval request is a document a client is asked to
// decide on, next to the hand-written mail it replaced, and as one wall of text it
// read like a machine had sent it: the versions, the fixed tickets, the schedule and
// the ask all in the same size, with the link to the rollout as a bare URL.
//
// So this renders blocks rather than a body. The blocks arrive already worded and
// already in the instance's notification language (the browser composes them, as it
// composes every notification — see NOTIFY_LANG), and nothing here knows what any
// of them mean: this module decides only what a heading, a fact line, a list of
// fixes, a quoted changelog, an ask with a button and a signature look like. The
// plain-text part is unchanged and still carries everything, because a mail client
// that shows text only must lose nothing but the layout.
//
// Rules this file follows, and the reasons they are not negotiable:
//   * Every value is escaped. The blocks come from a request body; a ticket title
//     with an `<` in it must not be able to end a tag, let alone open one.
//   * Every bound is enforced here. A caller cannot make the renderer emit an
//     unbounded document by sending three thousand list items.
//   * Only http(s) becomes an href (isUsableAppUrl), so a mistyped APP_BASE_URL
//     cannot turn the button into a `javascript:` link.
//   * Inline styles, tables for layout, no images, no external stylesheet, no
//     web font. Mail clients strip <style> blocks, ignore flexbox and block remote
//     content; a layout that needs any of them is a layout that arrives broken.
import { escapeHtml, isUsableAppUrl } from './appLink.js';

// The same teal the Teams card uses for its accent (`themeColor` in
// routes/notifications.js), so the two channels look like one product.
const ACCENT = '#0A6E7A';
const INK = '#1b2a32';
const MUTED = '#5a6b75';
const LINE = '#e2e8ec';
const WASH = '#f7f9fa';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

// Bounds. Generous enough for the largest real rollout (a release fixing eighty
// tickets across five applications) and finite, for the same reason every other
// value that crosses the API is finite — see the MAX_* clamps in releasePackage.js.
export const MAX_BLOCKS = 24;
export const MAX_ITEMS = 200;
const MAX_SHORT = 400;    // a heading, a fact, a label, one list row
const MAX_TEXT = 4000;    // a changelog, which is the only long block

const short = (v) => String(v == null ? '' : v).trim().slice(0, MAX_SHORT);
const long = (v) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim().slice(0, MAX_TEXT);
const esc = (v) => escapeHtml(v);
// A person-typed paragraph: escaped first, then its newlines become breaks, so the
// changelog keeps the shape the test team wrote it in.
const escLines = (v) => esc(v).replace(/\n/g, '<br>');

// One row of the card. The padding is on the cell rather than on a wrapper div,
// because Outlook drops margins on divs often enough that it is not worth finding
// out which version does.
function row(inner, { top = 0, bottom = 0 } = {}) {
  return `<tr><td style="padding:${top}px 28px ${bottom}px 28px;">${inner}</td></tr>`;
}

function sectionTitle(text) {
  return `<div style="font-size:11.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${MUTED};padding-bottom:8px;">${esc(text)}</div>`;
}

// The lead: the deployment id, linked, with the project next to it. The id is what
// the reader is asked to quote in their answer and what every list in RollDesk is
// searched by, so it is the headline rather than a field further down.
function leadRow(block, url) {
  const id = short(block.id);
  const title = short(block.title);
  const idHtml = !id ? ''
    : (url ? `<a href="${esc(url)}" style="color:${ACCENT};text-decoration:none;">${esc(id)}</a>` : esc(id));
  const sep = id && title ? '<span style="color:' + LINE + ';"> | </span>' : '';
  return row(
    `<div style="font-size:19px;font-weight:700;line-height:1.35;color:${INK};">`
    + `${idHtml}${sep}${title ? `<span style="font-weight:600;">${esc(title)}</span>` : ''}</div>`,
    { top: 26, bottom: 0 }
  );
}

// The facts everyone reads first and nobody wants labelled: the versions, the
// environment, how many targets over how many days. One muted line under the
// heading, separated as they are in the text part.
function factsRow(block) {
  const items = (Array.isArray(block.items) ? block.items : []).slice(0, MAX_ITEMS).map(short).filter(Boolean);
  if (!items.length) return '';
  return row(
    `<div style="font-size:13.5px;line-height:1.65;color:${MUTED};">${items.map(esc).join(' &middot; ')}</div>`,
    { top: 6, bottom: 0 }
  );
}

// Labelled facts, as a two-column table: „Start: Thursday, 2026-08-27 at 20:00".
// A table rather than one line per label with a <br>, so the values line up and a
// long one wraps under itself instead of under its label.
function metaRow(block) {
  const items = (Array.isArray(block.items) ? block.items : []).slice(0, MAX_ITEMS)
    .map((i) => ({ label: short(i && i.label), value: short(i && i.value) }))
    .filter((i) => i.label || i.value);
  if (!items.length) return '';
  const rows = items.map((i) => `<tr>`
    + `<td style="padding:3px 12px 3px 0;font-size:13px;color:${MUTED};white-space:nowrap;vertical-align:top;">${esc(i.label)}</td>`
    + `<td style="padding:3px 0;font-size:13px;color:${INK};vertical-align:top;">${esc(i.value)}</td></tr>`).join('');
  return row(
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0">${rows}</table>`,
    { top: 14, bottom: 0 }
  );
}

// „These versions fix these tickets" — the reason the mail exists. A table of
// ticket and title rather than a bulleted line each, because the client reads down
// the ticket column looking for the one they reported.
function listRow(block) {
  const items = (Array.isArray(block.items) ? block.items : []).slice(0, MAX_ITEMS)
    .map((i) => (typeof i === 'string'
      ? { name: short(i), note: '' }
      : { name: short(i && i.name), note: short(i && i.note) }))
    .filter((i) => i.name || i.note);
  if (!items.length) return '';
  const rows = items.map((i) => `<tr>`
    + `<td style="padding:4px 14px 4px 0;font-family:${MONO};font-size:12.5px;font-weight:600;color:${ACCENT};white-space:nowrap;vertical-align:top;">${esc(i.name)}</td>`
    + `<td style="padding:4px 0;font-size:13.5px;line-height:1.5;color:${INK};vertical-align:top;">${esc(i.note)}</td></tr>`).join('');
  return row(
    sectionTitle(block.title)
    + `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${rows}</table>`,
    { top: 22, bottom: 0 }
  );
}

// The changelog, as the test team wrote it: quoted in a washed box so it reads as
// somebody else's words rather than as more of the mail's own text.
function textRow(block) {
  const body = long(block.body);
  if (!body) return '';
  return row(
    sectionTitle(block.title)
    + `<div style="font-size:13.5px;line-height:1.6;color:${INK};background:${WASH};`
    + `border-left:3px solid ${LINE};padding:12px 14px;">${escLines(body)}</div>`,
    { top: 22, bottom: 0 }
  );
}

// What the reader is being asked for, and the one button in the mail. The URL is
// repeated as small text under it: a client that strips the anchor styling leaves a
// button that is not obviously a link, and a reader who wants to forward the
// rollout to a colleague needs the address itself.
function askRow(block, url) {
  const text = long(block.text);
  const label = short(block.button);
  const button = (url && label)
    ? `<div style="padding-top:16px;">`
      + `<a href="${esc(url)}" style="display:inline-block;background:${ACCENT};color:#ffffff;`
      + `text-decoration:none;font-size:14px;font-weight:600;line-height:1;padding:13px 22px;border-radius:6px;">${esc(label)}</a>`
      + `</div>`
      + `<div style="padding-top:8px;font-size:11.5px;color:${MUTED};word-break:break-all;">`
      + `<a href="${esc(url)}" style="color:${MUTED};">${esc(url)}</a></div>`
    : '';
  if (!text && !button) return '';
  return row(
    (text ? `<div style="font-size:14.5px;line-height:1.6;color:${INK};font-weight:600;">${escLines(text)}</div>` : '')
    + button,
    { top: 24, bottom: 0 }
  );
}

function noteRow(block) {
  const text = long(block.text);
  if (!text) return '';
  return row(`<div style="font-size:12.5px;line-height:1.6;color:${MUTED};">${escLines(text)}</div>`, { top: 14, bottom: 0 });
}

// The project's sign-off, above a hairline: the last thing read, and the answer to
// „who is asking me to approve this".
function footerRow(footer) {
  const text = long(footer);
  if (!text) return '';
  return row(
    `<div style="border-top:1px solid ${LINE};margin-top:24px;padding-top:16px;`
    + `font-size:13px;line-height:1.6;color:${INK};">${escLines(text)}</div>`,
    { top: 0, bottom: 0 }
  );
}

const RENDERERS = {
  lead: (b, url) => leadRow(b, url),
  facts: (b) => factsRow(b),
  meta: (b) => metaRow(b),
  list: (b) => listRow(b),
  text: (b) => textRow(b),
  ask: (b, url) => askRow(b, url),
  note: (b) => noteRow(b),
};

// Render the HTML part, or '' when there is nothing to render — the caller then
// falls back to the plain body in a paragraph, which is what every notification
// that sends no blocks still gets.
//
// `link` is {label, url} of the deployment: the lead's id links to it and the ask's
// button opens it. `footer` is the project's signature, appended last (the same
// order as the text part, see mailBodyParts in appLink.js).
export function renderMailHtml({ blocks, footer, link, appUrl } = {}) {
  const list = Array.isArray(blocks) ? blocks.slice(0, MAX_BLOCKS) : [];
  const url = link && isUsableAppUrl(link.url) ? String(link.url).trim()
    : (isUsableAppUrl(appUrl) ? String(appUrl).trim() : '');
  const rows = list
    .filter((b) => b && typeof b === 'object' && RENDERERS[b.kind])
    .map((b) => RENDERERS[b.kind](b, url))
    .filter(Boolean);
  if (!rows.length) return '';
  const body = rows.join('') + footerRow(footer)
    // Bottom padding as its own row: putting it on the last block's cell would mean
    // every renderer having to know whether it is last.
    + `<tr><td style="height:28px;"></td></tr>`;
  return '<!DOCTYPE html>'
    + `<html><body style="margin:0;padding:0;background:#eef2f4;">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef2f4;padding:24px 12px;">`
    + `<tr><td align="center">`
    + `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="640" `
    + `style="width:100%;max-width:640px;background:#ffffff;border:1px solid ${LINE};border-radius:10px;font-family:${FONT};">`
    + `<tr><td style="height:4px;background:${ACCENT};font-size:0;line-height:0;">&nbsp;</td></tr>`
    + body
    + `</table></td></tr></table></body></html>`;
}
