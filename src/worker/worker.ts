import type { AppContext } from '../context';
import { NotReadyError } from '../context';
import type { Job } from '../db/repo';
import { processCallIntake, type CallIntakePayload } from '../flows/callIntake';
import { processRecording, type RecordingJobPayload } from '../flows/recording';
import { postEstimateShoutout, type EstimateShoutoutPayload } from '../flows/estimateShoutout';
import { pushAircallContact, type AircallContactPushPayload } from '../flows/aircallContactPush';

/**
 * DB-backed polling worker. Claims one due job at a time (FOR UPDATE SKIP
 * LOCKED), runs the matching flow, and marks success / retry / dead-letter.
 * Multiple instances can run safely against the same table.
 */
export class Worker {
  private running = false;
  private stopped = false;

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    void this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  private async loop(): Promise<void> {
    const { logger, repo, config } = this.ctx;
    logger.info('worker started');
    while (!this.stopped) {
      let job: Job | null = null;
      try {
        job = await repo.claimNextJob();
      } catch (err) {
        logger.error({ err: String(err) }, 'failed to claim job');
      }

      if (!job) {
        await sleep(config.WORKER_POLL_INTERVAL_MS);
        continue;
      }

      await this.runJob(job);
    }
    logger.info('worker stopped');
  }

  /** Exposed for tests: run a single claimed job through dispatch + outcome. */
  async runJob(job: Job): Promise<void> {
    const { logger, repo, config } = this.ctx;
    const started = Date.now();
    const log = logger.child({ job_id: job.id, type: job.type, attempt: job.attempts });
    try {
      await this.dispatch(job);
      await repo.completeJob(job.id);
      log.info({ latency_ms: Date.now() - started }, 'job done');
    } catch (err) {
      if (err instanceof NotReadyError) {
        const schedule = config.RECORDING_POLL_SCHEDULE_MIN;
        const idx = job.attempts - 1;
        if (idx < schedule.length) {
          const delayMs = (schedule[idx] ?? 1) * 60_000;
          await repo.deferJob(job.id, delayMs, err.message);
          log.info({ next_poll_in_ms: delayMs }, 'not ready yet; deferred');
        } else {
          await repo.completeJob(job.id);
          log.warn('resource never became ready within poll schedule; giving up');
        }
        return;
      }

      const backoff = backoffMs(job.attempts);
      const outcome = await repo.failJob(job.id, String(err), backoff);
      log[outcome === 'dead' ? 'error' : 'warn'](
        { err: String(err), outcome, backoff_ms: backoff, latency_ms: Date.now() - started },
        outcome === 'dead' ? 'job dead-lettered' : 'job failed; will retry',
      );
    }
  }

  private async dispatch(job: Job): Promise<void> {
    switch (job.type) {
      case 'call_intake':
        return processCallIntake(this.ctx, job.payload as unknown as CallIntakePayload);
      case 'recording':
        return processRecording(this.ctx, job.payload as unknown as RecordingJobPayload);
      case 'estimate_shoutout':
        return postEstimateShoutout(this.ctx, job.payload as unknown as EstimateShoutoutPayload);
      case 'aircall_contact_push':
        return pushAircallContact(this.ctx, job.payload as unknown as AircallContactPushPayload);
      default:
        throw new Error(`unknown job type: ${job.type}`);
    }
  }
}

function backoffMs(attempt: number): number {
  const base = Math.min(30 * 60_000, 1000 * 2 ** attempt);
  return Math.floor(base + Math.random() * base * 0.25);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
