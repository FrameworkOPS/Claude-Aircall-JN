import { Pool } from 'pg';
import type { Config } from '../config';

let pool: Pool | undefined;

export function getPool(config: Config): Pool {
  if (pool) return pool;
  pool = new Pool({
    connectionString: config.DATABASE_URL,
    ssl: config.DATABASE_SSL === 'require' ? { rejectUnauthorized: false } : undefined,
    max: 10,
  });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
