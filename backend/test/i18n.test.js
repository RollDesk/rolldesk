// Translation-consistency checks for the frontend UI dictionary.
//
// The single-page app keeps its translations in per-language bundles
// (frontend/app/i18n/pl.js, en.js). Each bundle assigns `window.RD_I18N.<lang>`
// and `window.RD_HELP.<lang>`. The markup (frontend/app/index.html) marks
// translatable nodes with data-i18n / data-i18n-ph / data-i18n-html attributes.
// These tests load the bundles in a sandbox (without a browser) and enforce:
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
import vm from 'node:vm';

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/app');
const HTML_PATH = path.join(APP_DIR, 'index.html');

// Run the language bundles in a sandbox that provides a fake `window`, then
// return the populated RD_I18N / RD_HELP globals.
function loadBundles() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  for (const file of ['i18n/pl.js', 'i18n/en.js']) {
    vm.runInContext(readFileSync(path.join(APP_DIR, file), 'utf8'), sandbox, { filename: file });
  }
  return { I18N: sandbox.window.RD_I18N, HELP: sandbox.window.RD_HELP };
}

function usedKeys(html) {
  return new Set(
    [...html.matchAll(/data-i18n(?:-ph|-html)?="([^"]+)"/g)].map((m) => m[1])
  );
}

test('pl and en dictionaries expose the same keys', () => {
  const { I18N } = loadBundles();
  const plKeys = new Set(Object.keys(I18N.pl));
  const enKeys = new Set(Object.keys(I18N.en));

  const missingInEn = [...plKeys].filter((k) => !enKeys.has(k));
  const missingInPl = [...enKeys].filter((k) => !plKeys.has(k));

  assert.deepEqual(missingInEn, [], `keys present in pl but missing in en: ${missingInEn.join(', ')}`);
  assert.deepEqual(missingInPl, [], `keys present in en but missing in pl: ${missingInPl.join(', ')}`);
});

test('every data-i18n key used in the markup is translated in both languages', () => {
  const { I18N } = loadBundles();
  const html = readFileSync(HTML_PATH, 'utf8');
  const plKeys = new Set(Object.keys(I18N.pl));
  const enKeys = new Set(Object.keys(I18N.en));

  const undefinedKeys = [...usedKeys(html)].filter((k) => !plKeys.has(k) || !enKeys.has(k));
  assert.deepEqual(undefinedKeys, [], `data-i18n keys with no translation: ${undefinedKeys.join(', ')}`);
});

test('the HELP documentation is present in both languages', () => {
  const { HELP } = loadBundles();
  assert.ok(HELP && HELP.pl && HELP.en, 'expected RD_HELP.pl and RD_HELP.en to be defined');
  assert.deepEqual(
    Object.keys(HELP.pl).sort(),
    Object.keys(HELP.en).sort(),
    'HELP_CONTENT pl/en expose different top-level keys'
  );
});

test('the dictionary is non-trivial (sanity check the bundles loaded)', () => {
  const { I18N } = loadBundles();
  assert.ok(Object.keys(I18N.pl).length > 50, 'expected the pl dictionary to contain many keys');
  assert.ok(Object.keys(I18N.en).length > 50, 'expected the en dictionary to contain many keys');
});
