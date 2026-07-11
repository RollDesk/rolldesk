import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingMigrations } from '../src/migrate.js';

test('returns all .sql files sorted when nothing is applied', () => {
  const files = ['002_add_index.sql', '001_init.sql', '003_seed.sql'];
  assert.deepEqual(pendingMigrations(files, []), [
    '001_init.sql',
    '002_add_index.sql',
    '003_seed.sql',
  ]);
});

test('ignores non-.sql entries', () => {
  const files = ['001_init.sql', 'README.md', '.keep', 'notes.txt'];
  assert.deepEqual(pendingMigrations(files, []), ['001_init.sql']);
});

test('excludes already-applied migrations', () => {
  const files = ['001_init.sql', '002_add_index.sql', '003_seed.sql'];
  const applied = new Set(['001_init.sql', '002_add_index.sql']);
  assert.deepEqual(pendingMigrations(files, applied), ['003_seed.sql']);
});

test('accepts an array of applied filenames as well as a Set', () => {
  const files = ['001_init.sql', '002_add_index.sql'];
  assert.deepEqual(pendingMigrations(files, ['001_init.sql']), ['002_add_index.sql']);
});

test('returns an empty list when everything is applied', () => {
  const files = ['001_init.sql', '002_add_index.sql'];
  const applied = ['001_init.sql', '002_add_index.sql'];
  assert.deepEqual(pendingMigrations(files, applied), []);
});

test('orders numeric prefixes lexicographically (zero-padded convention)', () => {
  const files = ['010_late.sql', '002_second.sql', '001_first.sql'];
  assert.deepEqual(pendingMigrations(files, []), [
    '001_first.sql',
    '002_second.sql',
    '010_late.sql',
  ]);
});
