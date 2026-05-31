import type { Logger } from 'pino';
import type { Config } from './config';
import type { Repo } from './db/repo';
import type { AircallClient } from './clients/aircall';
import type { JobNimbusClient } from './clients/jobnimbus';
import type { SlackClient } from './clients/slack';

/** Everything the flows and worker need, injected for testability. */
export interface AppContext {
  config: Config;
  logger: Logger;
  repo: Repo;
  aircall: AircallClient;
  jobnimbus: JobNimbusClient;
  slack: SlackClient;
}

/** Marks an error as retryable vs terminal for the worker's retry logic. */
export class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableError';
  }
}

/** Signals "not an error, just not ready yet" — defer without consuming an attempt. */
export class NotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotReadyError';
  }
}
