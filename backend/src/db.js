import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;
export const pool = new Pool({ connectionString: config.databaseUrl });

export async function query(text, params) {
  return pool.query(text, params);
}
export async function ping() {
  await pool.query('SELECT 1');
  return true;
}
