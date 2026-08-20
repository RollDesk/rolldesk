// Give every unnamed release package a name — a one-off for the packages that were
// assembled before names existed, run by hand:
//
//   npm run name:packages            (add --dry-run to see what it would do)
//
// A script rather than a migration, for the same reason the seed is a script: the
// names come from the word lists in packageName.js, and putting those in SQL would be
// a second copy of them with nothing keeping the two in step. It is idempotent — a
// package that already carries a name is never touched, so running it twice is
// harmless and running it after the next import is the point.
//
// Ordered oldest first, so the sequence of names follows the sequence of releases
// rather than the order Postgres happens to return.
import { query, pool } from './db.js';
import { generatePackageName, normalizeName } from './packageName.js';

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const { rows: all } = await query('SELECT id, name FROM release_packages');
  // Every name in use, including the ones handed out during this run: two historical
  // packages must not end up with the same name.
  const taken = all.map((r) => r.name).filter((n) => n && String(n).trim());
  const unnamed = all.filter((r) => !r.name || !String(r.name).trim()).map((r) => r.id).sort();

  if (!unnamed.length) {
    console.log('[name:packages] Every package already has a name — nothing to do.');
    return;
  }
  console.log(`[name:packages] ${unnamed.length} package(s) without a name` + (dryRun ? ' (dry run)' : ''));

  for (const id of unnamed) {
    const name = generatePackageName({ taken });
    taken.push(name);
    if (dryRun) {
      console.log(`  ${id} → ${name}`);
      continue;
    }
    // Only while it is still unnamed: if somebody named it in the meantime (this runs
    // against a live instance), theirs wins.
    const { rowCount } = await query(
      `UPDATE release_packages SET name = $2, updated_at = updated_at
        WHERE id = $1 AND (name IS NULL OR btrim(name) = '')`,
      [id, name]
    );
    console.log(`  ${id} → ${name}${rowCount ? '' : ' (skipped — named in the meantime)'}`);
    // `updated_at` is deliberately left where it was: naming a two-week-old release is
    // not a change to that release, and moving the timestamp would reorder the
    // packages list and every "recently touched" reading of it.
  }
  // A last sanity check on the invariant the whole script exists to keep.
  const { rows: after } = await query('SELECT name FROM release_packages WHERE name IS NOT NULL');
  const seen = new Set();
  const dupes = [];
  after.forEach((r) => {
    const key = normalizeName(r.name);
    if (seen.has(key)) dupes.push(r.name);
    seen.add(key);
  });
  if (dupes.length) console.warn(`[name:packages] duplicate names in use: ${dupes.join(', ')}`);
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(`[name:packages] failed: ${err.message}`);
    await pool.end().catch(() => {});
    process.exit(1);
  });
