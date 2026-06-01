import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { loadMigrationConfig } from '../config';
import { createLogger } from '../logger';
import { getPool, closePool } from './pool';

/**
 * Minimal forward-only migration runner. Applies any *.sql file in
 * ./migrations that has not been recorded in schema_migrations, in name order.
 *
 * Takes a pool + logger so it can be invoked in-process at web startup (sharing
 * the app's pool, no teardown) or from the standalone CLI wrapper below.
 */
export async function runMigrations(pool: Pool, logger: Logger): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const dir = join(__dirname, 'migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const { rows } = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
    if (rows.length > 0) {
      logger.info({ file }, 'migration already applied; skipping');
      continue;
    }
    const sql = readFileSync(join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      logger.info({ file }, 'migration applied');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ file, err: String(err) }, 'migration failed');
      throw err;
    } finally {
      client.release();
    }
  }

  logger.info('migrations complete');
}

/** Standalone CLI entrypoint: `node dist/db/migrate.js`. */
async function main(): Promise<void> {
  const config = loadMigrationConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const pool = getPool(config);
  // Don't let an idle-client error during/after teardown crash the process.
  pool.on('error', (err) => logger.warn({ err: String(err) }, 'pg pool error (ignored)'));
  try {
    await runMigrations(pool, logger);
  } finally {
    await closePool().catch(() => undefined);
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
