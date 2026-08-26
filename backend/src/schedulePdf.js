// The rollout schedule as a PDF, attached to the client's approval request.
//
// The mail describes the release and asks for a decision; the schedule is the part
// the client circulates internally, and a mail body is not what gets forwarded to
// twenty branches or printed and taken to a meeting. So it also travels as one file,
// generated per send rather than stored: the schedule is edited until the moment it
// is sent, and an attachment that is a day out of date is worse than none.
//
// It is deliberately the same document the deployments view already exports (its
// „PDF" button opens a print view of the same table) — same title, same subtitle,
// same columns, same rows, built by the same buildScheduleRows() in the browser.
// This module only draws it. Anything this file invented on its own — a summary of
// the release, a generated-by line — is gone: the client must be able to put the mail
// attachment and a fresh export side by side and see one schedule, not two.
//
// Two halves, for the same reason as everywhere else in this backend: `scheduleDoc`
// is pure and holds every decision that can be wrong (what is missing, what is too
// long, how many rows may be printed), so it is unit-tested without pdfkit; and
// `renderSchedulePdf` only draws.
//
// The wording and the language arrive from the browser, already translated, exactly
// as the mail's own blocks do (NOTIFY_LANG pins a notification's language to the
// instance, not to whoever pressed the button). Nothing here knows what a column
// means — which is also why the rows are plain strings.
//
// The font is committed under src/assets/fonts rather than taken from the system:
// the 14 standard PDF fonts are WinAnsi-encoded and have no ą, ę, ł, ś or ż, so a
// Polish schedule rendered in Helvetica loses letters in office names. DejaVu Sans
// covers them, is redistributable (see LICENSE-DejaVu.txt beside it), and being in
// the image means a bare `npm start` and the container produce the same document.
import PDFDocument from 'pdfkit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets/fonts');
export const FONT_REGULAR = path.join(FONT_DIR, 'DejaVuSans.ttf');
export const FONT_BOLD = path.join(FONT_DIR, 'DejaVuSans-Bold.ttf');

// Bounds. One row per deployment target, as the schedule the app exports has: the
// whole PWPW estate is 399 of them, so the cap is several times the largest real
// rollout rather than a guess at a typical one. The columns are application,
// version, target code, date and weekday plus the project's own per-target fields,
// which is why there is room for more than five.
export const MAX_ROWS = 2000;
export const MAX_COLUMNS = 12;
const MAX_CELL = 2000;
const MAX_SHORT = 300;
// Narrower than this and a date or a weekday breaks mid-value, which is worse than a
// wrapped application name.
const MIN_COLUMN = 46;

const ACCENT = '#0A6E7A';
const INK = '#1b2a32';
const MUTED = '#5a6b75';
const LINE = '#d8e0e5';
const WASH = '#f4f7f8';

const short = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, MAX_SHORT);
const cell = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, MAX_CELL);

// A filename a mail client will not mangle: the id is enough to tell two
// attachments apart in a mailbox, and anything outside this set is either a path
// separator or something Outlook silently rewrites.
export function scheduleFilename(raw, fallback = 'harmonogram.pdf') {
  const name = String(raw == null ? '' : raw).trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    // Leading dots and dashes go as well: nothing traverses out of a mail header, but
    // „..-..-etc-passwd.pdf" in a client's attachment list reads as an attack.
    .replace(/^[-.]+/, '').replace(/[-.]+$/, '');
  if (!name) return fallback;
  const withExt = /\.pdf$/i.test(name) ? name : `${name}.pdf`;
  return withExt.slice(0, 120);
}

// The document, normalized. Returns null when there is nothing worth attaching —
// no rows means no schedule, and an empty table in a client's inbox raises a
// question instead of answering one.
export function scheduleDoc(input) {
  const src = input && typeof input === 'object' ? input : {};
  const rows = (Array.isArray(src.rows) ? src.rows : [])
    .slice(0, MAX_ROWS)
    .map((r) => (Array.isArray(r) ? r : [r]).slice(0, MAX_COLUMNS).map(cell))
    .filter((r) => r.some(Boolean));
  if (!rows.length) return null;
  const columns = (Array.isArray(src.columns) ? src.columns : []).slice(0, MAX_COLUMNS).map(short);
  // Every row is padded to the header's width so a short row cannot shift the
  // columns of the ones under it.
  const width = Math.max(columns.length, ...rows.map((r) => r.length));
  return {
    title: short(src.title) || 'Harmonogram',
    subtitle: short(src.subtitle),
    columns: Array.from({ length: width }, (_, i) => columns[i] || ''),
    rows: rows.map((r) => Array.from({ length: width }, (_, i) => r[i] || '')),
    filename: scheduleFilename(src.filename),
    // Reported back so a caller can say „2000-row cap, 12 dropped"
    // rather than silently attaching a truncated schedule.
    dropped: Math.max(0, (Array.isArray(src.rows) ? src.rows.length : 0) - rows.length),
  };
}

// Column widths: the last column takes what is left, because it holds the target
// list and is the only one that needs to wrap. The others are sized to their
// content once, from the header and the widest cell, so „Dzień 1" does not get a
// third of the page.
function columnWidths(doc, model, available) {
  const n = model.columns.length;
  if (n === 1) return [available];
  // What each column would like: its header and its widest value, capped so one long
  // cell (the application column of a five-application release) cannot take the page.
  const natural = model.columns.map((head, i) => {
    doc.font(FONT_BOLD).fontSize(9);
    let w = doc.widthOfString(head);
    doc.font(FONT_REGULAR).fontSize(9.5);
    for (const row of model.rows) w = Math.max(w, doc.widthOfString(row[i] || ''));
    // A cap per column, so the application column of a five-application release
    // („Kierowca / Lokalny komponent / …") cannot take a third of the page and leave
    // the target and the date fighting over what is left.
    // The padding is generous on purpose: at +14 „Świdnica" measured 3 pt narrower
    // than its own column and pdfkit still wrapped it onto a second line.
    return Math.min(w + 20, available * 0.26);
  });
  const total = natural.reduce((a, b) => a + b, 0);
  if (total <= available) {
    // Spare room shared out in proportion, so the table fills the page evenly. Giving
    // it all to the widest column (the first attempt) left „Województwo" three times
    // the width it needed while „Kod celu" stayed at the edge of wrapping.
    return natural.map((w) => w + (available - total) * (w / total));
  }
  // Wider than the page. The columns are shrunk towards a readable floor rather than
  // scaled uniformly — the earlier version gave the leftovers to the last column,
  // which is how „Dzień: czwartek" arrived in the client's schedule as „Thurs".
  const floors = natural.map((w) => Math.min(w, MIN_COLUMN));
  if (floors.reduce((a, b) => a + b, 0) >= available) {
    return model.columns.map(() => available / n);
  }
  const slack = natural.reduce((a, w, i) => a + (w - floors[i]), 0);
  const keep = slack > 0 ? Math.max(0, 1 - (total - available) / slack) : 0;
  return natural.map((w, i) => floors[i] + (w - floors[i]) * keep);
}

// Draw the header. Repeated on every page: a schedule that runs to page three is
// read on page three, and „which rollout is this" must not be on page one only.
function drawHeader(doc, model, first) {
  const left = doc.page.margins.left;
  doc.font(FONT_BOLD).fontSize(first ? 17 : 11).fillColor(INK).text(model.title, left, doc.y);
  if (model.subtitle) {
    doc.font(FONT_BOLD).fontSize(first ? 12 : 9.5).fillColor(ACCENT)
      .text(model.subtitle, { paragraphGap: 2 });
  }
  doc.moveDown(0.6);
  const y = doc.y;
  doc.moveTo(left, y).lineTo(doc.page.width - doc.page.margins.right, y)
    .lineWidth(first ? 1.4 : 0.6).strokeColor(first ? ACCENT : LINE).stroke();
  doc.moveDown(0.7);
}

function drawTableHead(doc, model, widths) {
  const left = doc.page.margins.left;
  const top = doc.y;
  const height = 18;
  const totalWidth = widths.reduce((a, b) => a + b, 0);
  doc.rect(left, top, totalWidth, height).fillColor(WASH).fill();
  let x = left;
  doc.font(FONT_BOLD).fontSize(9).fillColor(MUTED);
  model.columns.forEach((head, i) => {
    doc.text(head, x + 6, top + 5, { width: widths[i] - 12, ellipsis: true });
    x += widths[i];
  });
  doc.y = top + height;
}

// Room for one more row on this page, given how tall it is going to be.
function fits(doc, height) {
  return doc.y + height <= doc.page.height - doc.page.margins.bottom;
}

export function renderSchedulePdf(model) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        // Portrait for a narrow table, landscape once there are enough columns to
        // squeeze it: at six columns a portrait page wrapped „Kod celu" onto two lines
        // and broke „2026-08-27" across them, while the client's own four-column
        // schedule reads better upright and prints the way a list should.
        layout: model.columns.length > 4 ? 'landscape' : 'portrait',
        margins: { top: 40, bottom: 40, left: 40, right: 40 },
        info: { Title: [model.title, model.subtitle].filter(Boolean).join(' - '), Creator: 'RollDesk' },
      });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.registerFont(FONT_REGULAR, FONT_REGULAR);
      doc.registerFont(FONT_BOLD, FONT_BOLD);

      const left = doc.page.margins.left;
      const available = doc.page.width - left - doc.page.margins.right;
      drawHeader(doc, model, true);
      const widths = columnWidths(doc, model, available);
      drawTableHead(doc, model, widths);

      model.rows.forEach((row, index) => {
        doc.font(FONT_REGULAR).fontSize(9.5);
        // The tallest cell decides the row: the target list wraps over several lines
        // and the day number must stay beside its own targets.
        const heights = row.map((value, i) =>
          doc.heightOfString(value, { width: widths[i] - 12 }));
        const height = Math.max(16, Math.max(...heights) + 8);
        if (!fits(doc, height)) {
          doc.addPage();
          drawHeader(doc, model, false);
          drawTableHead(doc, model, widths);
        }
        const top = doc.y;
        if (index % 2 === 1) {
          doc.rect(left, top, widths.reduce((a, b) => a + b, 0), height).fillColor('#fbfcfc').fill();
        }
        let x = left;
        row.forEach((value, i) => {
          doc.font(i === 0 ? FONT_BOLD : FONT_REGULAR).fontSize(9.5).fillColor(INK)
            .text(value, x + 6, top + 4, { width: widths[i] - 12 });
          x += widths[i];
        });
        doc.y = top + height;
        doc.moveTo(left, doc.y).lineTo(left + widths.reduce((a, b) => a + b, 0), doc.y)
          .lineWidth(0.5).strokeColor(LINE).stroke();
      });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// What the mail actually attaches: the model, drawn, as a nodemailer attachment.
// Returns null when there is no schedule to attach, so the caller has one check.
export async function schedulePdfAttachment(input) {
  const model = scheduleDoc(input);
  if (!model) return null;
  const content = await renderSchedulePdf(model);
  return { filename: model.filename, content, contentType: 'application/pdf', dropped: model.dropped };
}
