import { buildContext } from './app';
import { buildServer } from './server';
import { Worker } from './worker/worker';
import { getPool, closePool } from './db/pool';
import { runMigrations } from './db/migrate';

/**
 * Web entry point: runs database migrations, then starts the Fastify webhook
 * receiver and, unless RUN_WORKER_IN_WEB=false, the worker loop in the same
 * process. Running migrations in-process (sharing the app pool) avoids a
 * fragile separate migrate process whose DB/SSL teardown could abort the boot.
 */
async function main(): Promise<void> {
  const ctx = buildContext();
  const { config, logger } = ctx;

  await runMigrations(getPool(config), logger);

  const app = buildServer(ctx);

  let worker: Worker | undefined;
  if (config.RUN_WORKER_IN_WEB) {
    worker = new Worker(ctx);
    worker.start();
  }

  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info({ port: config.PORT, worker_in_web: config.RUN_WORKER_IN_WEB }, 'server listening');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await worker?.stop();
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  // Synchronous write so a startup failure is never lost to buffered stderr.
  process.stderr.write(`FATAL: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(1);
});
