// Local test-data seeder.
// Loads backend/src/seeds/local.sql (which is NOT committed — see .gitignore) into the
// database pointed to by DATABASE_URL. This keeps real/sample client data out of the
// repository. Run it with `npm run seed`, or point it at another file:
//   node src/seed.js path/to/other.sql
import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const SEEDS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seeds');
export const DEFAULT_SEED_FILE = path.join(SEEDS_DIR, 'local.sql');

export async function runSeed({ file = DEFAULT_SEED_FILE, log = console.log } = {}) {
  try {
    await access(file, constants.R_OK);
  } catch {
    log(`[seed] No local seed file found at ${file} — skipping.`);
    log('[seed] Copy backend/src/seeds/local.sql.example to local.sql and adjust it.');
    return { seeded: false };
  }
  const sql = await readFile(file, 'utf8');
  log(`[seed] Loading ${path.basename(file)} ...`);
  await pool.query(sql);
  log('[seed] Done.');
  return { seeded: true };
}

// Allow running as a standalone CLI: `node src/seed.js [file]`.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const file = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_SEED_FILE;
  runSeed({ file })
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch(err => {
      console.error('[seed] Failed:', err.message);
      process.exit(1);
    });
}
