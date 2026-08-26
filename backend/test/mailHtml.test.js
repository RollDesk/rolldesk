// The HTML part of the client's approval request.
//
// What is worth testing here is not the styling but the three things that make an
// HTML mail either safe or broken: everything person-typed is escaped, every list is
// bounded, and the parts appear in the order the message is read in (heading, facts,
// fixes, changelog, ask with its button, signature). Plus the fallback: no blocks
// means no HTML from here at all, so the caller keeps sending what it always did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMailHtml, MAX_BLOCKS, MAX_ITEMS } from '../src/mailHtml.js';

const URL_OK = 'https://rolldesk.example.com';
const DEP_URL = `${URL_OK}/#deployments/DEP-1`;

const BLOCKS = [
  { kind: 'lead', id: 'DEP-2026-0075', title: 'Test PIK' },
  { kind: 'facts', items: ['Kierowca v9.9.9', 'Produkcja', '399 celów'] },
  { kind: 'meta', items: [{ label: 'Start', value: 'czwartek, 2026-08-27 o 20:00' }] },
  { kind: 'list', title: 'Poprawione błędy (2)', items: [
    { name: 'PR-0165668', note: 'Brak podpisu na wydruku' },
    { name: 'PR-0165630', note: 'Błędny numer sprawy' },
  ] },
  { kind: 'text', title: 'Lista zmian', body: 'first line\nsecond line' },
  { kind: 'ask', text: 'Prosimy o akceptację', button: 'Otwórz wdrożenie' },
  { kind: 'note', text: 'Odpowiedź trafi do zespołu w kopii.' },
];

function render(over = {}) {
  return renderMailHtml(Object.assign(
    { blocks: BLOCKS, footer: 'Pozdrawiam,\nZespół PiK', link: { label: 'DEP-1', url: DEP_URL }, appUrl: URL_OK },
    over
  ));
}

test('with no blocks there is no HTML, so the caller falls back to the plain body', () => {
  for (const blocks of [undefined, null, [], 'nonsense', [{}, { kind: 'unknown' }, null]]) {
    assert.equal(renderMailHtml({ blocks, footer: 'x', appUrl: URL_OK }), '');
  }
});

test('the parts appear in the order the message is read in', () => {
  const html = render();
  const order = ['DEP-2026-0075', 'Kierowca v9.9.9', 'Start', 'PR-0165668', 'Lista zmian',
    'Prosimy o akceptację', 'Otwórz wdrożenie', 'Odpowiedź trafi', 'Zespół PiK'];
  let at = -1;
  for (const needle of order) {
    const found = html.indexOf(needle);
    assert.ok(found > at, `${needle} is out of order (at ${found}, previous ${at})`);
    at = found;
  }
});

test('it is one self-contained document with no remote or scripted content', () => {
  const html = render();
  assert.ok(html.startsWith('<!DOCTYPE html>'), html.slice(0, 40));
  assert.ok(html.trimEnd().endsWith('</html>'));
  // Mail clients strip <style> and block remote images; a layout that needs either
  // arrives broken, and a <script> is what a filter drops the whole mail for.
  for (const forbidden of ['<style', '<script', '<img', 'background-image', 'javascript:']) {
    assert.ok(!html.includes(forbidden), `${forbidden} must not appear`);
  }
});

test('the heading links to the deployment and the button opens it', () => {
  const html = render();
  assert.ok(html.includes(`<a href="${DEP_URL}"`), 'the id is the anchor');
  // The button and the URL under it, so a client that strips the styling still
  // leaves something to click and something to copy.
  assert.equal((html.match(new RegExp(DEP_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 4);
});

test('with no deployment link the button falls back to the app itself', () => {
  const html = render({ link: null });
  assert.ok(html.includes(`href="${URL_OK}"`), html.slice(0, 300));
});

test('with no usable URL at all the mail still renders, without a button', () => {
  const html = render({ link: null, appUrl: '' });
  assert.ok(html.includes('Prosimy o akceptację'), 'the ask survives');
  assert.ok(!html.includes('Otwórz wdrożenie'), 'nothing to open, so no button');
  assert.ok(!html.includes('<a href'), 'and no anchors at all');
});

test('a javascript: URL is not a link', () => {
  const html = render({ link: { label: 'DEP-1', url: 'javascript:alert(1)' }, appUrl: 'javascript:alert(1)' });
  assert.ok(!html.includes('javascript'), html);
});

test('every person-typed value is escaped', () => {
  const html = renderMailHtml({
    blocks: [
      { kind: 'lead', id: '<b>DEP</b>', title: '"Proj" & Co' },
      { kind: 'facts', items: ['<script>alert(1)</script>'] },
      { kind: 'meta', items: [{ label: '<i>Start</i>', value: '<br>' }] },
      { kind: 'list', title: '<h1>Fixes</h1>', items: [{ name: '<a href=x>', note: "it's <bad>" }] },
      { kind: 'text', title: '<u>Log</u>', body: '<img src=x onerror=alert(1)>' },
      { kind: 'ask', text: '<b>ask</b>', button: '<b>go</b>' },
      { kind: 'note', text: '</td></tr></table>END' },
    ],
    footer: '<b>Regards</b>',
    appUrl: URL_OK,
  });
  // Needles a legitimate document cannot contain, so the assertion is about the
  // input having been escaped and not about the layout's own markup.
  for (const raw of ['<b>DEP', '<script', '<i>Start', '<h1>', '<a href=x', '<img', '<u>', '</table>END', '<b>Regards']) {
    assert.ok(!html.includes(raw), `${raw} leaked into the document`);
  }
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&quot;Proj&quot; &amp; Co'));
  assert.ok(html.includes('it&#39;s &lt;bad&gt;'));
  assert.ok(html.includes('&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;END'));
  // Two tables of layout and the two the blocks render (meta, list) — nothing the
  // input added.
  assert.equal((html.match(/<table/g) || []).length, 4);
});

test('a changelog keeps its line breaks and nothing else', () => {
  const html = render();
  assert.ok(html.includes('first line<br>second line'), html);
});

test('the lists are bounded, so a caller cannot make the document unbounded', () => {
  const items = Array.from({ length: MAX_ITEMS + 40 }, (_, i) => ({ name: `PR-${i}`, note: 'x' }));
  const html = renderMailHtml({ blocks: [{ kind: 'list', title: 'many', items }], appUrl: URL_OK });
  assert.ok(html.includes(`PR-${MAX_ITEMS - 1}`), 'the last item within the bound is there');
  assert.ok(!html.includes(`PR-${MAX_ITEMS}`), 'and the first one past it is not');

  const blocks = Array.from({ length: MAX_BLOCKS + 10 }, (_, i) => ({ kind: 'note', text: `note-${i}` }));
  const many = renderMailHtml({ blocks, appUrl: URL_OK });
  assert.ok(many.includes(`note-${MAX_BLOCKS - 1}`));
  assert.ok(!many.includes(`note-${MAX_BLOCKS}`));

  // One long value is cut rather than carried whole: a heading is a heading.
  const long = renderMailHtml({ blocks: [{ kind: 'lead', id: 'D'.repeat(900), title: '' }], appUrl: URL_OK });
  assert.ok(!long.includes('D'.repeat(500)), 'a 900-character id is clamped');
});

test('an empty block contributes no empty row', () => {
  const html = renderMailHtml({
    blocks: [{ kind: 'lead', id: 'DEP-1', title: 'P' }, { kind: 'facts', items: [] },
      { kind: 'list', title: 'FIXES-TITLE', items: [] },
      { kind: 'text', title: 'LOG-TITLE', body: '   ' },
      { kind: 'note', text: '' }],
    appUrl: URL_OK,
  });
  assert.ok(!html.includes('FIXES-TITLE'), 'a list with no rows drops its title too');
  assert.ok(!html.includes('LOG-TITLE'), 'and so does a changelog with no text');
});

test('the signature is the last thing in the document, and optional', () => {
  const withSign = render();
  assert.ok(withSign.indexOf('Zespół PiK') > withSign.indexOf('Odpowiedź trafi'));
  assert.ok(withSign.includes('Pozdrawiam,<br>Zespół PiK'));
  for (const empty of ['', '  \n ', null, undefined]) {
    assert.ok(!render({ footer: empty }).includes('Pozdrawiam'));
  }
});
