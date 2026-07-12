import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;
export const pool = new Pool({ connectionString: config.databaseUrl });

// pg emits an 'error' event when an idle client fails (e.g. the database
// restarts or drops the connection). Without a listener Node treats it as an
// unhandled error and crashes the process, so we log and let the pool recover
// on the next query. This keeps the backend alive so /health can report the
// database as down instead of the whole process going away.
pool.on('error', (err) => {
  console.error('[db] Idle client error:', err.message);
});

export async function query(text, params) {
  return pool.query(text, params);
}
export async function ping() {
  await pool.query('SELECT 1');
  return true;
}
