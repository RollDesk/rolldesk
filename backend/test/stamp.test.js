// The timeline/audit stamps are display strings, so the zone they are rendered
// in is part of the behaviour: a stamp written in UTC sorts and reads two hours
// behind one the browser wrote from the same office in summer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatStamp, isValidTimeZone } from '../src/stamp.js';

// 2026-07-30 12:05 UTC — inside Polish summer time (UTC+2).
const SUMMER = new Date('2026-07-30T12:05:00Z');
// 2026-01-15 23:40 UTC — Polish winter time (UTC+1), and late enough that the
// zone shift rolls the date over.
const WINTER = new Date('2026-01-15T23:40:00Z');

test('renders the stamp in the requested zone, not the runtime one', () => {
  assert.deepEqual(formatStamp(SUMMER, 'Europe/Warsaw'), { date: '2026-07-30', time: '14:05' });
  assert.deepEqual(formatStamp(SUMMER, 'UTC'), { date: '2026-07-30', time: '12:05' });
});

test('honours the offset in force on that date, not a fixed one', () => {
  // +1 in January, so 23:40Z is 00:40 the next day.
  assert.deepEqual(formatStamp(WINTER, 'Europe/Warsaw'), { date: '2026-01-16', time: '00:40' });
});

test('midnight is 00:xx, never 24:xx', () => {
  const midnight = new Date('2026-03-02T00:20:00Z');
  assert.deepEqual(formatStamp(midnight, 'UTC'), { date: '2026-03-02', time: '00:20' });
});

test('zero-pads every component to the stored shape', () => {
  const s = formatStamp(new Date('2026-04-05T06:07:00Z'), 'UTC');
  assert.equal(s.date, '2026-04-05');
  assert.equal(s.time, '06:07');
});

test('an empty zone falls back to the runtime zone instead of throwing', () => {
  for (const zone of ['', null, undefined]) {
    const s = formatStamp(SUMMER, zone);
    assert.match(s.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(s.time, /^\d{2}:\d{2}$/);
  }
});

test('isValidTimeZone accepts zones this runtime understands', () => {
  // Fixed offsets are accepted by Intl too; they are a legitimate (if worse)
  // answer than a named zone, since they do not follow daylight saving.
  for (const zone of ['Europe/Warsaw', 'UTC', 'America/New_York', '+02:00']) {
    assert.equal(isValidTimeZone(zone), true, `expected ${zone} to be valid`);
  }
});

test('isValidTimeZone rejects a typo rather than letting it throw per request', () => {
  for (const zone of ['Europe/Warszawa', 'CEST', 'Mars/Olympus', '', null, undefined]) {
    assert.equal(isValidTimeZone(zone), false, `expected ${JSON.stringify(zone)} to be rejected`);
  }
});
