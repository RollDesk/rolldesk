// The per-application progress rules exist twice: in src/appProgress.js, with the
// tests, and again in frontend/app/index.html, because the UI is a single file
// with no module loader (the same arrangement as prioritizeReportingTargets).
//
// Two copies of a rule drift, and this one decides whether a rollout reports
// "installed", "partly installed" or "failed" — a browser copy that disagreed
// with the backend would store a status the API would not have derived, and
// nothing else in the suite would notice. So the browser copy is lifted out of
// the markup by name, run in a sandbox, and checked against the module for the
// same inputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as backend from '../src/appProgress.js';

// The sandbox returns objects and arrays built by another realm's constructors, so
// a strict deep comparison fails on the prototype alone. Compare the values.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const HTML_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../frontend/app/index.html'
);

// The mirrored helpers, in dependency order. `appCoverage` takes the deployment
// record in the browser (that is what every caller there has) rather than the
// {counts, totalLocations} pair the module takes, so the comparison passes the
// same numbers through both shapes.
const MIRRORED = [
  'statusFromAppResults', 'appJoinedAt', 'appCoverage', 'appsHaveMixedCoverage', 'failedAppsAt',
];

// Cut `function name(...){ ... }` out of the markup by matching braces. A regex
// alone cannot find the end of a function body that contains braces of its own.
function extractFunction(src, name) {
  const start = src.indexOf(`\n  function ${name}(`);
  assert.notEqual(start, -1, `${name}() is not defined in index.html — the mirror was renamed or removed`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces while reading ${name}() from index.html`);
}

function loadMirror() {
  const html = readFileSync(HTML_PATH, 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(MIRRORED.map((n) => extractFunction(html, n)).join('\n'), sandbox, {
    filename: 'index.html (mirrored appProgress helpers)',
  });
  MIRRORED.forEach((n) => assert.equal(typeof sandbox[n], 'function', `${n} did not load`));
  return sandbox;
}

const NAMES = ['Kolektor', 'Portal', 'Rejestr', 'Raporty'];

test('the browser copy derives the same status as the backend', () => {
  const ui = loadMirror();
  const cases = [
    [NAMES.map((name) => ({ name, status: 'installed' })), NAMES],
    [NAMES.map((name) => ({ name, status: 'failed' })), NAMES],
    // Two of four — the case the whole status exists for.
    [[{ name: 'Kolektor', status: 'installed' }, { name: 'Portal', status: 'installed' },
      { name: 'Rejestr', status: 'failed' }, { name: 'Raporty', status: 'failed' }], NAMES],
    // An application nobody reported on: an application added mid-rollout.
    [NAMES.slice(0, 3).map((name) => ({ name, status: 'installed' })), NAMES],
    [[], NAMES],
    [null, NAMES],
    [[{ name: 'PORTAL', status: 'installed' }], ['portal']],
    [[{ name: 'A', status: 'failed' }, { name: 'B', status: 'installed' }], []],
  ];
  for (const [results, names] of cases) {
    assert.equal(
      ui.statusFromAppResults(results, names),
      backend.statusFromAppResults(results, names),
      `statusFromAppResults(${JSON.stringify(results)}, ${JSON.stringify(names)})`
    );
  }
});

test('the browser copy discounts a late-joining application the same way', () => {
  const ui = loadMirror();
  const apps = [
    { name: 'Kolektor' },
    { name: 'Raporty', since: { day: 4, date: '2026-08-19', installed: 120 } },
    { name: 'Rejestr', since: { day: 9, installed: 900 } },   // join point past the total
    { name: 'Portal', since: {} },                            // malformed → from the start
  ];
  const totals = [
    { counts: { installed: 120, scheduled: 280 }, totalLocations: 400 },
    { counts: { installed: 160, scheduled: 240 }, totalLocations: 400 },
    { counts: { installed: 80, scheduled: 320 }, totalLocations: 400 },
    { counts: { installed: 400, scheduled: 0 }, totalLocations: 400 },
  ];
  for (const app of apps) {
    assert.ok(same(ui.appJoinedAt(app), backend.appJoinedAt(app)), `appJoinedAt(${JSON.stringify(app)})`);
    for (const t of totals) {
      assert.ok(
        same(ui.appCoverage(app, { counts: t.counts, totalLocations: t.totalLocations }), backend.appCoverage(app, t)),
        `appCoverage(${JSON.stringify(app)}, ${JSON.stringify(t)})`
      );
    }
  }
  assert.equal(ui.appsHaveMixedCoverage(apps), backend.appsHaveMixedCoverage(apps));
  assert.equal(ui.appsHaveMixedCoverage([{ name: 'A' }]), backend.appsHaveMixedCoverage([{ name: 'A' }]));
});

test('the browser copy reads a failed target the same way', () => {
  const ui = loadMirror();
  const entries = [
    { location: 'WORD-7' },
    { location: 'WORD-7', failedApps: ['Rejestr', 'raporty'] },
    { location: 'WORD-7', failedApps: ['Archiwum'] },
    { location: 'WORD-7', failedApps: [] },
    null,
  ];
  for (const entry of entries) {
    assert.ok(
      same(ui.failedAppsAt(entry, NAMES), backend.failedAppsAt(entry, NAMES)),
      `failedAppsAt(${JSON.stringify(entry)})`
    );
  }
});
