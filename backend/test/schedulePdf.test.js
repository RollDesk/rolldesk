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

// The document the deployments view exports: one row per target, the project's own
// per-target column among the standard ones.
const INPUT = {
  filename: 'DEP-2026-0075-Kierowca.pdf',
  title: 'Harmonogram wdrożenia - Test PIK (PWPW) · Kierowca 9.9.9 · Produkcja',
  subtitle: 'ID: DEP-2026-0075 · Cele: 3 · Wygenerowano w RollDesk',
  columns: ['Aplikacja', 'Wersja', 'Kod celu', 'Województwo', 'Data', 'Dzień'],
  rows: [
    ['Kierowca', '9.9.9', 'Oddział Świdnica', 'dolnośląskie', '2026-08-27', 'czwartek'],
    ['Kierowca', '9.9.9', 'Oddział Żywiec', 'śląskie', '2026-08-27', 'czwartek'],
    ['Kierowca', '9.9.9', 'Oddział Łomża', 'podlaskie', '2026-08-28', 'piątek'],
  ],
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
  assert.equal(doc.title, INPUT.title);
  assert.equal(doc.subtitle, INPUT.subtitle);
  assert.deepEqual(doc.columns, INPUT.columns);
  assert.deepEqual(doc.rows[0], INPUT.rows[0]);
  assert.equal(doc.dropped, 0);
});

test('the document carries nothing of its own', async () => {
  // It has to be the same schedule the deployments view exports, so this module adds
  // no summary of the release and no generated-by line: two documents that are
  // „almost the same" leave the client deciding which one is the schedule.
  const doc = scheduleDoc(Object.assign({}, INPUT, {
    facts: ['invented'], meta: [{ label: 'invented', value: 'x' }], note: 'invented',
  }));
  assert.deepEqual(Object.keys(doc).sort(), ['columns', 'dropped', 'filename', 'rows', 'subtitle', 'title']);
  assert.ok(!JSON.stringify(doc).includes('invented'), 'nothing invented reaches the model');
  assert.ok(Buffer.isBuffer(await renderSchedulePdf(doc)), 'and it still renders');
});

test('a short row is padded, so it cannot shift the columns below it', () => {
  const doc = scheduleDoc(Object.assign({}, INPUT, { rows: [['Kierowca'], ['Kierowca', '9.9.9', 'x', 'y', 'z', 'w']] }));
  assert.deepEqual(doc.rows[0], ['Kierowca', '', '', '', '', '']);
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
  const rows = Array.from({ length: MAX_ROWS + 25 }, (_, i) => [`Kierowca`, '9.9.9', `Cel ${i + 1}`]);
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
  assert.equal(scheduleFilename('DEP-2026-0075-Kierowca.pdf'), 'DEP-2026-0075-Kierowca.pdf');
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
  const rows = Array.from({ length: 120 }, (_, i) => ['Kierowca', '9.9.9', `Oddział Świdnica ${i + 1}`, 'dolnośląskie', '2026-08-27', 'czwartek']);
  const pdf = await renderSchedulePdf(scheduleDoc(Object.assign({}, INPUT, { rows })));
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  assert.ok(pages >= 2, `expected more than one page, got ${pages}`);
});

test('the attachment is what nodemailer takes, or null', async () => {
  const file = await schedulePdfAttachment(INPUT);
  assert.equal(file.filename, 'DEP-2026-0075-Kierowca.pdf');
  assert.equal(file.contentType, 'application/pdf');
  assert.ok(Buffer.isBuffer(file.content));
  assert.equal(file.dropped, 0);
  assert.equal(await schedulePdfAttachment({ rows: [] }), null);
  assert.equal(await schedulePdfAttachment(null), null);
});
