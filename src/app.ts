import { loadConfig, type Config } from './config';
import { createLogger } from './logger';
import { getPool } from './db/pool';
import { Repo } from './db/repo';
import { AircallClient } from './clients/aircall';
import { JobNimbusClient } from './clients/jobnimbus';
import { SlackClient } from './clients/slack';
import type { AppContext } from './context';

/** Wire the full application context from configuration. */
export function buildContext(config: Config = loadConfig()): AppContext {
  const logger = createLogger(config.LOG_LEVEL);
  const repo = new Repo(getPool(config));
  return {
    config,
    logger,
    repo,
    aircall: new AircallClient(config, logger),
    jobnimbus: new JobNimbusClient(config, logger),
    slack: new SlackClient(config, logger),
  };
}
