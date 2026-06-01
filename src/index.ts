import { writeSync } from 'node:fs';
import { buildContext } from './app';
import { buildServer } from './server';
import { Worker } from './worker/worker';
import { closePool } from './db/pool';

// Synchronous, unbuffered boot trace so startup is visible in container logs
// even if the process later hangs or exits before async stdout flushes.
const boot = (msg: string) => writeSync(1, `[boot] ${msg}\n`);

/**
 * Web entry point: starts the Fastify webhook receiver and, unless
 * RUN_WORKER_IN_WEB=false, the worker loop in the same process.
 */
async function main(): Promise<void> {
  boot('index.js entered');
  const ctx = buildContext();
  const { config, logger } = ctx;
  boot(`context built; PORT=${config.PORT} HOST=${config.HOST}`);
  const app = buildServer(ctx);
  boot('server built');

  let worker: Worker | undefined;
  if (config.RUN_WORKER_IN_WEB) {
    worker = new Worker(ctx);
    worker.start();
  }

  boot('calling app.listen');
  await app.listen({ port: config.PORT, host: config.HOST });
  boot('app.listen resolved');
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
  // Synchronous write so the failure is never lost to buffered stderr.
  writeSync(2, `[boot] FATAL: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(1);
});
