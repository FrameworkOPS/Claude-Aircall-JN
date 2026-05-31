import { buildContext } from './app';
import { buildServer } from './server';
import { Worker } from './worker/worker';
import { closePool } from './db/pool';

/**
 * Web entry point: starts the Fastify webhook receiver and, unless
 * RUN_WORKER_IN_WEB=false, the worker loop in the same process.
 */
async function main(): Promise<void> {
  const ctx = buildContext();
  const { config, logger } = ctx;
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
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
