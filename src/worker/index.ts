import { buildContext } from '../app';
import { Worker } from './worker';
import { closePool } from '../db/pool';

/**
 * Standalone worker entry point — run as a separate Railway service when
 * RUN_WORKER_IN_WEB=false so the web dyno isn't doing slow background work.
 */
async function main(): Promise<void> {
  const ctx = buildContext();
  const worker = new Worker(ctx);
  worker.start();

  const shutdown = async (signal: string) => {
    ctx.logger.info({ signal }, 'worker shutting down');
    await worker.stop();
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
