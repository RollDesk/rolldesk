// The stored shape of a project's client-mail footer.
//
// The footer is free text an operator writes once and every approval request to
// that client's project then carries, so the two things worth pinning down are the
// bound (it lands in the project's JSONB, which is bounded everywhere else for the
// same reason) and what a paste out of Outlook or Word turns into.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMailFooter, MAX_MAIL_FOOTER } from '../src/projectMail.js';

test('an absent or unusable footer normalizes to the empty string', () => {
  assert.equal(normalizeMailFooter(undefined), '');
  assert.equal(normalizeMailFooter(null), '');
  assert.equal(normalizeMailFooter(''), '');
  assert.equal(normalizeMailFooter('   \n  \n '), '');
  // Not a string: the value arrives in a request body, so a number or an object is
  // a client's mistake rather than something to coerce into a mail.
  assert.equal(normalizeMailFooter(42), '');
  assert.equal(normalizeMailFooter({ text: 'Regards' }), '');
});

test('the text an operator typed survives verbatim', () => {
  const footer = 'Pozdrawiam,\nZespół PiK\npik-eskalacje@example.com';
  assert.equal(normalizeMailFooter(footer), footer);
});

test('a paste from Windows is folded to plain newlines', () => {
  assert.equal(normalizeMailFooter('Regards,\r\nThe team'), 'Regards,\nThe team');
  assert.equal(normalizeMailFooter('Regards,\rThe team'), 'Regards,\nThe team');
});

test('surrounding blank space goes, and a run of blank lines becomes one', () => {
  assert.equal(normalizeMailFooter('\n\n  Regards,\n\n\n\nThe team  \n\n'), 'Regards,\n\nThe team');
});

test('control characters are dropped, the tab and the newline are not', () => {
  // A footer is composed into a mail body; a vertical tab or a NUL in it is never
  // something anybody meant to write, while a tab is ordinary text.
  assert.equal(normalizeMailFooter('Regards,\u000b\nThe team\u0000'), 'Regards,\nThe team');
  assert.equal(normalizeMailFooter('a\tb'), 'a\tb');
});

test('a footer longer than the bound is clamped, not rejected', () => {
  const long = 'x'.repeat(MAX_MAIL_FOOTER + 500);
  const out = normalizeMailFooter(long);
  assert.equal(out.length, MAX_MAIL_FOOTER);
  // Clamped at the bound and trimmed afterwards, so the cut cannot leave the
  // footer ending in half a blank line.
  assert.equal(normalizeMailFooter('y'.repeat(MAX_MAIL_FOOTER - 1) + '   z', MAX_MAIL_FOOTER),
    'y'.repeat(MAX_MAIL_FOOTER - 1));
});

test('the bound is a parameter, so a caller can be stricter', () => {
  assert.equal(normalizeMailFooter('abcdef', 3), 'abc');
});
