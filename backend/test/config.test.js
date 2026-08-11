import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.js reads process.env at import time, so we set env vars first and then
// import a fresh module instance using a cache-busting query string.
async function loadConfig(env) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const mod = await import(`../src/config.js?t=${Math.random()}`);
    return mod.config;
  } finally {
    // Restore only the keys we touched.
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('parses a comma-separated ALLOWED_IPS list and trims entries', async () => {
  const config = await loadConfig({ ALLOWED_IPS: '203.0.113.4, 198.51.100.0/24 ,10.8.0.0/24' });
  assert.deepEqual(config.allowedIps, ['203.0.113.4', '198.51.100.0/24', '10.8.0.0/24']);
});

test('an empty ALLOWED_IPS yields an empty list', async () => {
  const config = await loadConfig({ ALLOWED_IPS: '' });
  assert.deepEqual(config.allowedIps, []);
});

test('trustProxy is true only when TRUST_PROXY equals "1"', async () => {
  assert.equal((await loadConfig({ TRUST_PROXY: '1' })).trustProxy, true);
  assert.equal((await loadConfig({ TRUST_PROXY: '0' })).trustProxy, false);
  assert.equal((await loadConfig({ TRUST_PROXY: 'true' })).trustProxy, false);
});

test('smtp.secure is true only for the string "true"', async () => {
  assert.equal((await loadConfig({ SMTP_SECURE: 'true' })).smtp.secure, true);
  assert.equal((await loadConfig({ SMTP_SECURE: 'false' })).smtp.secure, false);
});

test('port falls back to 3000 when PORT is unset', async () => {
  const config = await loadConfig({ PORT: '' });
  assert.equal(config.port, 3000);
});

test('NOTIFY_LANG accepts pl/en and ignores case and padding', async () => {
  assert.equal((await loadConfig({ NOTIFY_LANG: 'pl' })).notifyLang, 'pl');
  assert.equal((await loadConfig({ NOTIFY_LANG: ' EN ' })).notifyLang, 'en');
});

// An unset value must stay unset rather than defaulting to a language: it means
// "compose in the UI language of whoever triggered the event", which is what an
// instance upgrading from before this variable existed already does.
test('an unset NOTIFY_LANG leaves the sender\'s UI language in charge', async () => {
  for (const empty of ['', '   ']) assert.equal((await loadConfig({ NOTIFY_LANG: empty })).notifyLang, '');
});

test('an unsupported NOTIFY_LANG warns and falls back instead of failing startup', async () => {
  const warn = console.warn;
  const warnings = [];
  console.warn = (msg) => warnings.push(String(msg));
  try {
    assert.equal((await loadConfig({ NOTIFY_LANG: 'de' })).notifyLang, '');
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /NOTIFY_LANG "de"/);
});

// The issue ids on a release package are stored exactly as the testers type
// them, so linking them needs a pattern saying where the id belongs — a base URL
// would only work for trackers that happen to put it last in the path.
test('ISSUE_TRACKER_URL is taken as-is when it carries the {id} placeholder', async () => {
  const config = await loadConfig({ ISSUE_TRACKER_URL: '  https://tracker.example.com/t?id={id}  ' });
  assert.equal(config.issueTrackerUrl, 'https://tracker.example.com/t?id={id}');
});

// A pattern without {id} would link every issue to the same page, which reads as
// a working link and isn't one. Dropping it shows the ids as plain text instead.
test('an ISSUE_TRACKER_URL without {id} warns and is dropped rather than linking every id to one page', async () => {
  const warn = console.warn;
  const warnings = [];
  console.warn = (msg) => warnings.push(String(msg));
  try {
    assert.equal((await loadConfig({ ISSUE_TRACKER_URL: 'https://tracker.example.com/tickets' })).issueTrackerUrl, '');
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ISSUE_TRACKER_URL/);
});

test('an unset ISSUE_TRACKER_URL leaves the issue ids as plain text', async () => {
  for (const empty of ['', '   ']) assert.equal((await loadConfig({ ISSUE_TRACKER_URL: empty })).issueTrackerUrl, '');
});
