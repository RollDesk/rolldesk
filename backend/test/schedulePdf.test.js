// The schedule attached to the client's approval request.
//
// Split the way the module is: `scheduleDoc` holds every decision that can be wrong
// (what is missing, what is too long, how many rows may be printed) and is checked
// exactly; the renderer is checked for the few things a broken PDF gets wrong —
// it is a real document, it has the pages the rows need, and the Polish letters that
// the 14 standard PDF fonts do not have are in it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scheduleDoc, scheduleFilename, renderSchedulePdf, schedulePdfAttachment, MAX_ROWS, MAX_COLUMNS,
} from '../src/schedulePdf.js';

const INPUT = {
  filename: 'Harmonogram-DEP-2026-0075.pdf',
  title: 'Harmonogram wdrożenia',
  subtitle: 'DEP-2026-0075 - Test PIK',
  facts: ['Kierowca v9.9.9', 'Produkcja', '399 celów'],
  meta: [{ label: 'Start', value: 'czwartek, 2026-08-27 o 20:00' }],
  columns: ['Dzień', 'Data', 'Cele wdrożenia'],
  rows: [
    ['Dzień 1', '2026-08-27', 'Oddział Świdnica, Oddział Żywiec'],
    ['Dzień 2', '2026-08-28', 'Oddział Łomża'],
  ],
  note: 'Wygenerowano automatycznie.',
};

test('no rows means no document, so nothing empty is ever attached', () => {
  for (const rows of [undefined, null, [], [[]], [['', '  ']], 'nonsense']) {
    assert.equal(scheduleDoc(Object.assign({}, INPUT, { rows })), null);
  }
  assert.equal(scheduleDoc(undefined), null);
  assert.equal(scheduleDoc('nonsense'), null);
});

test('the rows and their wording survive', () => {
  const doc = scheduleDoc(INPUT);
  assert.equal(doc.title, 'Harmonogram wdrożenia');
  assert.equal(doc.subtitle, 'DEP-2026-0075 - Test PIK');
  assert.deepEqual(doc.columns, ['Dzień', 'Data', 'Cele wdrożenia']);
  assert.deepEqual(doc.rows[0], ['Dzień 1', '2026-08-27', 'Oddział Świdnica, Oddział Żywiec']);
  assert.equal(doc.dropped, 0);
});

test('a short row is padded, so it cannot shift the columns below it', () => {
  const doc = scheduleDoc(Object.assign({}, INPUT, { rows: [['Dzień 1'], ['Dzień 2', '2026-08-28', 'x']] }));
  assert.deepEqual(doc.rows[0], ['Dzień 1', '', '']);
  assert.equal(doc.rows[0].length, doc.rows[1].length);
});

test('a table wider than the header is still square', () => {
  // More cells than columns: the header grows with the widest row rather than the
  // extra values being dropped where nobody would notice.
  const doc = scheduleDoc({ columns: ['A'], rows: [['1', '2', '3']] });
  assert.equal(doc.columns.length, 3);
  assert.deepEqual(doc.columns, ['A', '', '']);
});

test('the row and column caps hold, and what was cut is reported', () => {
  const rows = Array.from({ length: MAX_ROWS + 25 }, (_, i) => [`Dzień ${i + 1}`, '2026-08-27', 'x']);
  const doc = scheduleDoc(Object.assign({}, INPUT, { rows }));
  assert.equal(doc.rows.length, MAX_ROWS);
  assert.equal(doc.dropped, 25, 'a truncated schedule says so rather than looking complete');

  const wide = scheduleDoc({ columns: [], rows: [Array.from({ length: MAX_COLUMNS + 4 }, (_, i) => `c${i}`)] });
  assert.equal(wide.rows[0].length, MAX_COLUMNS);

  // One enormous cell is clamped rather than carried into the document whole.
  const long = scheduleDoc({ columns: ['t'], rows: [['x'.repeat(5000)]] });
  assert.ok(long.rows[0][0].length <= 2000);
});

test('whitespace in a cell is collapsed, because a newline is not a row', () => {
  const doc = scheduleDoc({ columns: ['a'], rows: [['  Oddział\n  Świdnica  ']] });
  assert.equal(doc.rows[0][0], 'Oddział Świdnica');
});

test('the filename is one a mail client will not rewrite', () => {
  assert.equal(scheduleFilename('Harmonogram-DEP-2026-0075.pdf'), 'Harmonogram-DEP-2026-0075.pdf');
  assert.equal(scheduleFilename('Harmonogram DEP/2026'), 'Harmonogram-DEP-2026.pdf', 'a separator cannot survive');
  assert.equal(scheduleFilename('../../etc/passwd'), 'etc-passwd.pdf');
  assert.equal(scheduleFilename('harmonogram wdrożenia'), 'harmonogram-wdro-enia.pdf');
  assert.equal(scheduleFilename(''), 'harmonogram.pdf');
  assert.equal(scheduleFilename('   '), 'harmonogram.pdf');
  assert.ok(scheduleFilename('x'.repeat(400)).length <= 120);
});

test('the rendered file is a real PDF', async () => {
  const pdf = await renderSchedulePdf(scheduleDoc(INPUT));
  assert.ok(Buffer.isBuffer(pdf));
  assert.equal(pdf.slice(0, 5).toString('latin1'), '%PDF-');
  assert.ok(pdf.slice(-1024).toString('latin1').includes('%%EOF'), 'the trailer is there');
  assert.ok(pdf.length > 2000, `suspiciously small: ${pdf.length} bytes`);
});

test('the Polish letters are embedded, not dropped to a fallback font', async () => {
  const pdf = await renderSchedulePdf(scheduleDoc(INPUT));
  const raw = pdf.toString('latin1');
  // A subset of DejaVu rather than one of the 14 standard fonts: those are
  // WinAnsi-encoded and have no ą, ę, ł, ś or ż, so „Oddział Świdnica" would arrive
  // with holes in it.
  assert.match(raw, /\/FontFile2/, 'the font is embedded');
  assert.match(raw, /DejaVuSans/);
  assert.ok(!/\/BaseFont\s*\/Helvetica/.test(raw), 'nothing fell back to Helvetica');
});

test('a long schedule runs onto further pages', async () => {
  const rows = Array.from({ length: 120 }, (_, i) => [`Dzień ${i + 1}`, '2026-08-27', 'Oddział Świdnica']);
  const pdf = await renderSchedulePdf(scheduleDoc(Object.assign({}, INPUT, { rows })));
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  assert.ok(pages >= 2, `expected more than one page, got ${pages}`);
});

test('the attachment is what nodemailer takes, or null', async () => {
  const file = await schedulePdfAttachment(INPUT);
  assert.equal(file.filename, 'Harmonogram-DEP-2026-0075.pdf');
  assert.equal(file.contentType, 'application/pdf');
  assert.ok(Buffer.isBuffer(file.content));
  assert.equal(file.dropped, 0);
  assert.equal(await schedulePdfAttachment({ rows: [] }), null);
  assert.equal(await schedulePdfAttachment(null), null);
});
