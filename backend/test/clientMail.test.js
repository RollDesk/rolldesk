// Recipient handling for the client-facing approval request. Pure, so no SMTP
// server and no database are involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecipients, clientMailAudience, MAX_RECIPIENTS } from '../src/clientMail.js';

test('normalizeRecipients accepts bare addresses and {email} objects', () => {
  const { addresses, invalid } = normalizeRecipients([
    'k.zaluska@pwpw.pl',
    { email: 'a.mikina@pwpw.pl' },
    { address: 'm.bazyluk@pwpw.pl' },
  ]);
  assert.deepEqual(addresses, ['k.zaluska@pwpw.pl', 'a.mikina@pwpw.pl', 'm.bazyluk@pwpw.pl']);
  assert.deepEqual(invalid, []);
});

test('normalizeRecipients trims and keeps the spelling that was entered', () => {
  const { addresses } = normalizeRecipients(['  Edyta.Jastrzebska2@dxc.com  ']);
  assert.deepEqual(addresses, ['Edyta.Jastrzebska2@dxc.com']);
});

test('the same mailbox typed twice is one recipient', () => {
  const { addresses } = normalizeRecipients([
    'pwpw-sqm@dxc.com',
    'PWPW-SQM@dxc.com',
    { email: 'pwpw-sqm@DXC.com' },
  ]);
  assert.deepEqual(addresses, ['pwpw-sqm@dxc.com']);
});

test('a malformed address is reported, not dropped', () => {
  const { addresses, invalid } = normalizeRecipients(['ok@pwpw.pl', 'k.zaluska@', 'no-at-sign', '']);
  assert.deepEqual(addresses, ['ok@pwpw.pl']);
  assert.deepEqual(invalid, ['k.zaluska@', 'no-at-sign']);
});

test('empty and non-list input is an empty audience, never a throw', () => {
  assert.deepEqual(normalizeRecipients(undefined).addresses, []);
  assert.deepEqual(normalizeRecipients(null).addresses, []);
  assert.deepEqual(normalizeRecipients({}).addresses, []);
  // A single address rather than a list is accepted, because a caller sending one
  // recipient should not have to know it must be wrapped.
  assert.deepEqual(normalizeRecipients('one@pwpw.pl').addresses, ['one@pwpw.pl']);
});

test('the recipient list is bounded', () => {
  const many = Array.from({ length: MAX_RECIPIENTS + 20 }, (_, i) => `person${i}@pwpw.pl`);
  assert.equal(normalizeRecipients(many).addresses.length, MAX_RECIPIENTS);
  assert.equal(normalizeRecipients(many, 3).addresses.length, 3);
});

test('clientMailAudience copies the Cc list and answers to it', () => {
  const a = clientMailAudience({
    to: ['k.zaluska@pwpw.pl', 'a.mikina@pwpw.pl'],
    cc: ['pwpw-sqm@dxc.com', 'pik-eskalacje@dxc.com'],
  });
  assert.deepEqual(a.to, ['k.zaluska@pwpw.pl', 'a.mikina@pwpw.pl']);
  assert.deepEqual(a.cc, ['pwpw-sqm@dxc.com', 'pik-eskalacje@dxc.com']);
  // The whole point of the copy list: the client's reply has to reach it rather
  // than the no-reply sender.
  assert.deepEqual(a.replyTo, a.cc);
});

test('an address on both lists is only addressed, not also copied', () => {
  const a = clientMailAudience({
    to: ['k.zaluska@pwpw.pl', 'pwpw-sqm@dxc.com'],
    cc: ['PWPW-SQM@dxc.com', 'pik-eskalacje@dxc.com'],
  });
  assert.deepEqual(a.to, ['k.zaluska@pwpw.pl', 'pwpw-sqm@dxc.com']);
  assert.deepEqual(a.cc, ['pik-eskalacje@dxc.com']);
  assert.deepEqual(a.replyTo, ['pik-eskalacje@dxc.com']);
});

test('with no copy list there is no Reply-To to set', () => {
  const a = clientMailAudience({ to: ['k.zaluska@pwpw.pl'] });
  assert.deepEqual(a.cc, []);
  assert.deepEqual(a.replyTo, []);
});

test('clientMailAudience collects the rejected addresses from both lists', () => {
  const a = clientMailAudience({ to: ['ok@pwpw.pl', 'broken@'], cc: ['also-broken'] });
  assert.deepEqual(a.to, ['ok@pwpw.pl']);
  assert.deepEqual(a.invalid, ['broken@', 'also-broken']);
});
