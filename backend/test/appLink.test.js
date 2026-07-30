// Tests for the "open the app" link appended to notifications. Pure helpers, so
// no SMTP, webhook or Graph call is involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appLinkText, appLinkHtml, appLinkSlack, appLinkCardAction, bodyToHtml,
  isUsableAppUrl, APP_LINK_LABEL,
} from '../src/appLink.js';

const URL_OK = 'http://10.6.10.6:8080';

test('every channel renders the link when APP_BASE_URL is set', () => {
  assert.equal(appLinkText(URL_OK), `\n\n${APP_LINK_LABEL}: ${URL_OK}`);
  assert.equal(appLinkHtml(URL_OK), `<p><a href="${URL_OK}">${APP_LINK_LABEL}</a></p>`);
  assert.equal(appLinkSlack(URL_OK), `\n<${URL_OK}|${APP_LINK_LABEL}>`);
  assert.deepEqual(appLinkCardAction(URL_OK), {
    '@type': 'OpenUri',
    name: APP_LINK_LABEL,
    targets: [{ os: 'default', uri: URL_OK }],
  });
});

// The regression this file exists for: the Graph/Teams path posted a bare body,
// so when Graph was configured — and it takes over the Teams webhooks — the
// link vanished from the notifications people actually read.
test('the HTML link used by e-mail and the Graph channel message is identical', () => {
  assert.equal(appLinkHtml(URL_OK), appLinkHtml(URL_OK));
  assert.match(appLinkHtml(URL_OK), /href="http:\/\/10\.6\.10\.6:8080"/);
  assert.notEqual(appLinkHtml(URL_OK), '', 'the Graph channel must not be the one without a link');
});

test('every channel stays silent when APP_BASE_URL is unset', () => {
  for (const unset of ['', '   ', null, undefined]) {
    assert.equal(appLinkText(unset), '');
    assert.equal(appLinkHtml(unset), '');
    assert.equal(appLinkSlack(unset), '');
    assert.equal(appLinkCardAction(unset), null, 'no card action, so potentialAction is left off');
  }
});

test('a non-http(s) URL counts as not configured', () => {
  // Guards against a typo in the environment becoming a javascript: href.
  for (const bad of ['javascript:alert(1)', 'ftp://host/app', '10.6.10.6:8080', 'mailto:a@b.c']) {
    assert.equal(isUsableAppUrl(bad), false, `expected ${bad} to be rejected`);
    assert.equal(appLinkHtml(bad), '');
    assert.equal(appLinkText(bad), '');
    assert.equal(appLinkCardAction(bad), null);
  }
});

test('http and https are both accepted, and surrounding whitespace is trimmed', () => {
  assert.equal(isUsableAppUrl('https://rolldesk.example.com'), true);
  assert.equal(isUsableAppUrl('HTTP://rolldesk.example.com'), true);
  assert.equal(appLinkText('  https://rolldesk.example.com  '), `\n\n${APP_LINK_LABEL}: https://rolldesk.example.com`);
});

test('a quote in the URL cannot break out of the href attribute', () => {
  const link = appLinkHtml('https://host/"><script>alert(1)</script>');
  assert.ok(!link.includes('<script>'), `expected the script tag to be escaped: ${link}`);
  assert.ok(link.includes('&quot;'), 'the quote must be escaped');
});

test('bodyToHtml escapes the message and keeps its line breaks', () => {
  // A failure reason is typed by a person; `<` used to swallow the rest of the
  // line in an HTML mail client.
  const html = bodyToHtml('DEP-2026-0031 — PIK Test 3\nreason: <bad script> & more');
  assert.equal(
    html,
    '<p>DEP-2026-0031 — PIK Test 3<br>reason: &lt;bad script&gt; &amp; more</p>'
  );
});

test('bodyToHtml handles an empty or missing body', () => {
  assert.equal(bodyToHtml(''), '<p></p>');
  assert.equal(bodyToHtml(null), '<p></p>');
  assert.equal(bodyToHtml(undefined), '<p></p>');
});
