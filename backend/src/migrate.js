// Database migration runner.
// Applies versioned SQL migrations from src/migrations in filename order, tracking
// what has already run in a `schema_migrations` table. It is idempotent: migrations
// are applied exactly once, each in its own transaction. Runs on backend startup
// (see index.js) and can also be invoked directly: `node src/migrate.js`.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

export const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'migrations'
);

// Pure helper: given all directory entries and the set of already-applied files,
// return the .sql migrations that still need to run, in deterministic order.
export function pendingMigrations(allFiles, applied) {
  const appliedSet = applied instanceof Set ? applied : new Set(applied);
  return allFiles
    .filter(name => name.endsWith('.sql'))
    .sort()
    .filter(name => !appliedSet.has(name));
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

// Read-only status: which migrations are applied vs. still pending, without
// changing anything. Useful for /health and for the 'verify' startup mode.
export async function getMigrationStatus({ dir = MIGRATIONS_DIR } = {}) {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const { rows } = await client.query('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map(r => r.filename));
    const entries = await readdir(dir);
    const pending = pendingMigrations(entries, applied);
    return {
      upToDate: pending.length === 0,
      applied: [...applied].sort(),
      pending,
    };
  } finally {
    client.release();
  }
}

// Verify-only: check the database is fully migrated and throw if it isn't.
// Does NOT apply anything — migrations are expected to be run separately.
export async function verifyMigrations({ dir = MIGRATIONS_DIR, log = console.log } = {}) {
  const status = await getMigrationStatus({ dir });
  if (!status.upToDate) {
    throw new Error(
      `Database is not fully migrated — ${status.pending.length} pending migration(s): ${status.pending.join(', ')}`
    );
  }
  log('[migrate] Verified: database is up to date.');
  return status;
}

export async function runMigrations({ dir = MIGRATIONS_DIR, log = console.log } = {}) {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const { rows } = await client.query('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map(r => r.filename));

    const entries = await readdir(dir);
    const pending = pendingMigrations(entries, applied);

    if (!pending.length) {
      log('[migrate] Database is up to date — no pending migrations.');
      return { applied: [] };
    }

    const done = [];
    for (const file of pending) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      log(`[migrate] Applying ${file} ...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        done.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed and was rolled back: ${err.message}`);
      }
    }
    log(`[migrate] Applied ${done.length} migration(s): ${done.join(', ')}`);
    return { applied: done };
  } finally {
    client.release();
  }
}

// Allow running as a standalone CLI: `node src/migrate.js`.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runMigrations()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch(err => {
      console.error('[migrate] Failed:', err.message);
      process.exit(1);
    });
}
