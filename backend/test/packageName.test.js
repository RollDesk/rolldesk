// Tests for the release-package name suggestions. src/packageName.js is pure and its
// randomness is injected, so „what will it suggest" is a decidable question.
//
// The rule worth protecting is the grammar: an adjective is stored in three genders
// because Polish agreement is not optional, and „zardzewiały sowa" is the failure
// this file exists to catch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NAME_ADJECTIVES, NAME_NOUNS, nameSpaceSize, packageNameAt, normalizeName,
  generatePackageName,
} from '../src/packageName.js';

// A deterministic „random": walks the given values, then repeats the last one.
const seq = (...values) => {
  let i = 0;
  return () => {
    const v = values[Math.min(i, values.length - 1)];
    i += 1;
    return v;
  };
};

test('every adjective carries all three genders, and every noun names one', () => {
  NAME_ADJECTIVES.forEach((forms, i) => {
    assert.equal(forms.length, 3, `adjective ${i} does not have three forms`);
    forms.forEach((f) => assert.ok(f && typeof f === 'string' && f.trim(), `adjective ${i} has an empty form`));
  });
  NAME_NOUNS.forEach((n, i) => {
    assert.ok(n && n.word && n.word.trim(), `noun ${i} is empty`);
    assert.ok([0, 1, 2].includes(n.gender), `noun ${i} (${n && n.word}) has no usable gender`);
  });
});

test('the adjective agrees with the noun it is put in front of', () => {
  // The three genders, read off the lists rather than hard-coded, so the assertion
  // still means something when the words change.
  const masc = NAME_NOUNS.findIndex((n) => n.gender === 0);
  const fem = NAME_NOUNS.findIndex((n) => n.gender === 1);
  const neut = NAME_NOUNS.findIndex((n) => n.gender === 2);
  assert.ok(masc >= 0 && fem >= 0 && neut >= 0, 'all three genders must appear among the nouns');
  const adj = 3; // 'zardzewiały' / 'zardzewiała' / 'zardzewiałe'
  assert.equal(packageNameAt(adj, masc), `${cap(NAME_ADJECTIVES[adj][0])} ${NAME_NOUNS[masc].word}`);
  assert.equal(packageNameAt(adj, fem), `${cap(NAME_ADJECTIVES[adj][1])} ${NAME_NOUNS[fem].word}`);
  assert.equal(packageNameAt(adj, neut), `${cap(NAME_ADJECTIVES[adj][2])} ${NAME_NOUNS[neut].word}`);
});

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

test('a name reads like a name: capitalised, two words, no double spaces', () => {
  for (let a = 0; a < NAME_ADJECTIVES.length; a += 1) {
    for (let n = 0; n < NAME_NOUNS.length; n += 1) {
      const name = packageNameAt(a, n);
      assert.match(name, /^[A-ZĄĆĘŁŃÓŚŹŻ][^\s]* [^\s]+$/u, `unexpected shape: ${name}`);
    }
  }
});

test('an index outside the lists wraps rather than throwing', () => {
  // The generator divides a single random number, so a caller can hand in anything.
  assert.equal(packageNameAt(NAME_ADJECTIVES.length, 0), packageNameAt(0, 0));
  assert.equal(packageNameAt(-1, -1), packageNameAt(NAME_ADJECTIVES.length - 1, NAME_NOUNS.length - 1));
});

test('the space is big enough to be worth calling a name', () => {
  // Two names in a row being the same would make the whole idea pointless.
  assert.ok(nameSpaceSize() > 1000, `expected a four-figure name space, got ${nameSpaceSize()}`);
});

test('a suggestion avoids the names already in use', () => {
  const first = generatePackageName({ random: seq(0) });
  // Same roll, but that name is taken: the sweep moves on rather than repeating it.
  const second = generatePackageName({ taken: [first], random: seq(0), attempts: 1 });
  assert.notEqual(normalizeName(second), normalizeName(first));
});

test('comparison ignores case and stray space, as a person would', () => {
  const name = packageNameAt(0, 0);
  const again = generatePackageName({
    taken: ['  ' + name.toUpperCase() + '  '], random: seq(0), attempts: 1,
  });
  assert.notEqual(normalizeName(again), normalizeName(name));
  assert.equal(normalizeName('  Zardzewiały   Żubr '), 'zardzewiały żubr');
});

test('with the whole space taken it still returns a name', () => {
  // A suggestion that cannot be made must not become an empty field with no
  // explanation, so the fallback numbers the name instead of giving up.
  const all = [];
  for (let a = 0; a < NAME_ADJECTIVES.length; a += 1) {
    for (let n = 0; n < NAME_NOUNS.length; n += 1) all.push(packageNameAt(a, n));
  }
  const name = generatePackageName({ taken: all, random: seq(0) });
  assert.ok(name && name.trim(), 'expected a name');
  assert.ok(!all.map(normalizeName).includes(normalizeName(name)), `${name} is already taken`);
  assert.match(name, /\s\d+$/, `expected a numbered fallback, got ${name}`);
});

test('a hostile or missing taken-list is tolerated', () => {
  for (const taken of [null, undefined, 'nope', [null, '', '   ']]) {
    const name = generatePackageName({ taken, random: seq(0.5) });
    assert.ok(name && name.includes(' '), `expected a name for taken=${JSON.stringify(taken)}`);
  }
});
