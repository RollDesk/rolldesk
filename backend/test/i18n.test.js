// Translation-consistency checks for the frontend UI dictionary.
//
// The single-page app (frontend/app/index.html) keeps its i18n dictionary in an
// inline `const I18N = { pl: {...}, en: {...} }` object and marks translatable
// DOM nodes with data-i18n / data-i18n-ph / data-i18n-html attributes. These
// tests parse that file (without executing it) and enforce:
//   1. the `pl` and `en` dictionaries expose exactly the same set of keys, and
//   2. every key referenced from the markup exists in both languages.
//
// This catches the common regression of adding a UI string in one language only
// (or wiring up a data-i18n attribute without a matching translation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HTML_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../frontend/app/index.html'
);

function loadHtml() {
  return readFileSync(HTML_PATH, 'utf8');
}

// Pull the `pl: { ... }` and `en: { ... }` blocks out of the inline I18N object.
function languageBlocks(html) {
  const i18nStart = html.indexOf('const I18N = {');
  assert.ok(i18nStart !== -1, 'could not find `const I18N = {` in index.html');
  const plStart = html.indexOf('pl: {', i18nStart);
  const enStart = html.indexOf('en: {', plStart);
  const enEnd = html.indexOf('};', enStart);
  assert.ok(plStart !== -1 && enStart !== -1 && enEnd !== -1, 'could not locate pl/en dictionary blocks');
  return {
    pl: html.slice(plStart, enStart),
    en: html.slice(enStart, enEnd),
  };
}

// Keys are always written as a quoted token immediately followed by a colon,
// e.g. 'nav.projects':'Projects'. Values never contain that pattern.
function keysIn(block) {
  return new Set([...block.matchAll(/'([A-Za-z0-9_.]+)'\s*:/g)].map(m => m[1]));
}

function usedKeys(html) {
  return new Set(
    [...html.matchAll(/data-i18n(?:-ph|-html)?="([^"]+)"/g)].map(m => m[1])
  );
}

test('pl and en dictionaries expose the same keys', () => {
  const { pl, en } = languageBlocks(loadHtml());
  const plKeys = keysIn(pl);
  const enKeys = keysIn(en);

  const missingInEn = [...plKeys].filter(k => !enKeys.has(k));
  const missingInPl = [...enKeys].filter(k => !plKeys.has(k));

  assert.deepEqual(missingInEn, [], `keys present in pl but missing in en: ${missingInEn.join(', ')}`);
  assert.deepEqual(missingInPl, [], `keys present in en but missing in pl: ${missingInPl.join(', ')}`);
});

test('every data-i18n key used in the markup is translated in both languages', () => {
  const html = loadHtml();
  const { pl, en } = languageBlocks(html);
  const plKeys = keysIn(pl);
  const enKeys = keysIn(en);

  const undefinedKeys = [...usedKeys(html)].filter(k => !plKeys.has(k) || !enKeys.has(k));
  assert.deepEqual(undefinedKeys, [], `data-i18n keys with no translation: ${undefinedKeys.join(', ')}`);
});

test('the dictionary is non-trivial (sanity check the parser found keys)', () => {
  const { pl, en } = languageBlocks(loadHtml());
  assert.ok(keysIn(pl).size > 50, 'expected the pl dictionary to contain many keys');
  assert.ok(keysIn(en).size > 50, 'expected the en dictionary to contain many keys');
});
