// Tests for the "open the app" link appended to notifications. Pure helpers, so
// no SMTP, webhook or Graph call is involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appLinkText, appLinkHtml, appLinkSlack, appLinkCardAction, bodyToHtml,
  bodyToCardText, hasAppLink, isUsableAppUrl, APP_LINK_LABEL,
  deploymentUrl, linkLabelSlack, linkLabelMarkdown,
} from '../src/appLink.js';

const URL_OK = 'http://rolldesk.example.com';

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
  assert.match(appLinkHtml(URL_OK), /href="http:\/\/rolldesk\.example\.com"/);
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
  for (const bad of ['javascript:alert(1)', 'ftp://host/app', 'rolldesk.example.com', 'mailto:a@b.c']) {
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

// MessageCard renders Markdown: a lone newline collapses into a space, so the
// lines have to be joined with a hard break. Doubling every newline instead —
// what this used to do — kept them apart but put a blank line between each one,
// which is what made a notification carrying a changelog read as endless.
test('bodyToCardText keeps single line breaks without inserting blank lines', () => {
  const card = bodyToCardText('PIK_2 · DEP-2026-0046\nPojazd v52.13.32 · Produkcja\nStart: 2026-07-31');
  assert.equal(card, 'PIK_2 · DEP-2026-0046  \nPojazd v52.13.32 · Produkcja  \nStart: 2026-07-31');
  assert.ok(!/\n\s*\n/.test(card), 'no blank line may appear between consecutive body lines');
});

test('bodyToCardText preserves a blank line the author wrote deliberately', () => {
  // The changelog is separated from the header by an empty line on purpose.
  const card = bodyToCardText('header line\n\nLista zmian:\nPM21372 first\nPM21405 second');
  assert.equal(card, 'header line\n\nLista zmian:  \nPM21372 first  \nPM21405 second');
  assert.equal(card.split('\n\n').length, 2, 'exactly one paragraph break');
});

test('bodyToCardText collapses a run of blank lines into one paragraph break', () => {
  assert.equal(bodyToCardText('a\n\n\n\nb'), 'a\n\nb');
});

test('bodyToCardText normalises CRLF and handles an empty body', () => {
  assert.equal(bodyToCardText('a\r\nb'), 'a  \nb');
  assert.equal(bodyToCardText(''), '');
  assert.equal(bodyToCardText(null), '');
  assert.equal(bodyToCardText(undefined), '');
});

test('bodyToCardText leaves no NUL byte in the output', () => {
  // The first implementation used \0 as a sentinel for paragraph breaks; a body
  // that happened to contain one would have been mangled.
  const card = bodyToCardText('a\nb\n\nc');
  assert.ok(!card.includes('\0'), 'the card text must not contain a NUL byte');
});

// The UI builds its own labelled link into schedule notifications; without this
// guard every channel appended the generic one on top of it.
test('hasAppLink detects a link the body already carries', () => {
  const body = `Start: 2026-07-31\nOtwórz harmonogram w RollDesk: ${URL_OK}/#deployments`;
  assert.equal(hasAppLink(body, URL_OK), true);
  assert.equal(hasAppLink('no link here', URL_OK), false);
});

test('hasAppLink is false when no URL is configured, whatever the body says', () => {
  // With APP_BASE_URL unset there is no generic link to suppress anyway.
  assert.equal(hasAppLink(`see ${URL_OK}`, ''), false);
  assert.equal(hasAppLink(`see ${URL_OK}`, null), false);
  assert.equal(hasAppLink(`see ${URL_OK}`, 'javascript:alert(1)'), false);
});

test('hasAppLink tolerates an empty or missing body', () => {
  for (const empty of ['', null, undefined]) assert.equal(hasAppLink(empty, URL_OK), false);
});

// A notification is always about one deployment, so it links to that row rather
// than to the list — the app routes #deployments/<id> to it.
test('deploymentUrl points at the deployment, not the list', () => {
  assert.equal(deploymentUrl(URL_OK, 'DEP-2026-0048'), 'http://rolldesk.example.com/#deployments/DEP-2026-0048');
});

test('deploymentUrl does not double the slash on a base URL with a trailing one', () => {
  assert.equal(deploymentUrl('http://rolldesk.example.com/', 'DEP-1'), 'http://rolldesk.example.com/#deployments/DEP-1');
});

test('deploymentUrl is empty without a usable base URL or an id', () => {
  for (const bad of ['', null, 'javascript:alert(1)']) assert.equal(deploymentUrl(bad, 'DEP-1'), '');
  for (const noId of ['', '   ', null, undefined]) assert.equal(deploymentUrl(URL_OK, noId), '');
});

test('deploymentUrl escapes an id that would otherwise break the URL', () => {
  assert.equal(deploymentUrl(URL_OK, 'DEP 1/2'), 'http://rolldesk.example.com/#deployments/DEP%201%2F2');
});

// The id opens every notification body, so linking it in place is what lets the
// message drop its trailing "open the app" line.
test('the deployment id becomes the link in each channel markup', () => {
  const body = 'DEP-2026-0048 — PIK_2\nKierowca v38.14.88 · Produkcja';
  const url = deploymentUrl(URL_OK, 'DEP-2026-0048');
  assert.equal(
    linkLabelSlack(body, 'DEP-2026-0048', url),
    `<${url}|DEP-2026-0048> — PIK_2\nKierowca v38.14.88 · Produkcja`
  );
  assert.equal(
    linkLabelMarkdown(body, 'DEP-2026-0048', url),
    `[DEP-2026-0048](${url}) — PIK_2\nKierowca v38.14.88 · Produkcja`
  );
});

test('only the first occurrence of the id is linked', () => {
  // The id repeats in a changelog often enough that linking each one is noise.
  const out = linkLabelMarkdown('DEP-1 — proj\nsee DEP-1 again', 'DEP-1', URL_OK);
  assert.equal(out.match(/\]\(/g).length, 1);
  assert.ok(out.endsWith('see DEP-1 again'));
});

test('the body is returned unchanged when there is no URL or the id is absent', () => {
  const body = 'DEP-1 — proj';
  assert.equal(linkLabelSlack(body, 'DEP-1', ''), body);
  assert.equal(linkLabelMarkdown(body, 'DEP-1', 'javascript:alert(1)'), body);
  assert.equal(linkLabelMarkdown(body, 'DEP-9', URL_OK), body, 'an id not in the body must not be inserted');
  assert.equal(linkLabelMarkdown(body, '', URL_OK), body);
});

test('bodyToHtml links the id and still escapes the rest of the body', () => {
  const url = deploymentUrl(URL_OK, 'DEP-1');
  const html = bodyToHtml('DEP-1 — proj\nreason: <bad> & more', { label: 'DEP-1', url });
  assert.equal(
    html,
    `<p><a href="${url}">DEP-1</a> — proj<br>reason: &lt;bad&gt; &amp; more</p>`
  );
});

test('bodyToHtml with a link ignores an id that is not in the body', () => {
  const html = bodyToHtml('no id here', { label: 'DEP-1', url: deploymentUrl(URL_OK, 'DEP-1') });
  assert.equal(html, '<p>no id here</p>');
});

test('bodyToHtml cannot be made to emit markup through the link label', () => {
  // The label is escaped before it is looked up, so a body containing markup
  // characters can never produce an unescaped tag.
  const html = bodyToHtml('<img src=x> — proj', { label: '<img src=x>', url: URL_OK });
  assert.ok(!html.includes('<img'), `expected the tag to stay escaped: ${html}`);
  assert.ok(html.includes(`<a href="${URL_OK}">&lt;img src=x&gt;</a>`), html);
});
