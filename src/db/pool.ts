import { Pool } from 'pg';
import type { Config } from '../config';

let pool: Pool | undefined;

// Only the DB connection fields are needed here, so accept any config (full app
// config or the minimal migration config) that provides them.
type PoolConfig = Pick<Config, 'DATABASE_URL' | 'DATABASE_SSL'>;

export function getPool(config: PoolConfig): Pool {
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
