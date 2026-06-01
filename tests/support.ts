import pino from 'pino';
import type { Config } from '../src/config';
import type { AppContext } from '../src/context';

/** Minimal config for flow tests (no real network/db). */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    AIRCALL_API_ID: 'id',
    AIRCALL_API_TOKEN: 'token',
    AIRCALL_BASE_URL: 'https://api.aircall.io/v1',
    AIRCALL_WEBHOOK_SECRET: 'secret',
    AIRCALL_VERIFY_HMAC: false,
    AIRCALL_RATE_LIMIT_PER_MIN: 60,
    RECORDING_POLL_SCHEDULE_MIN: [1, 3, 5, 10],
    JOBNIMBUS_API_KEY: 'jn',
    JOBNIMBUS_BASE_URL: 'https://app.jobnimbus.com/api1',
    JOBNIMBUS_WEBHOOK_SECRET: 'jnsecret',
    JOBNIMBUS_RATE_LIMIT_PER_MIN: 100,
    ESTIMATE_SIGNED_STATUSES: ['signed', 'complete', 'completed'],
    ATTACH_TARGET: 'job',
    SLACK_BOT_TOKEN: '',
    SLACK_CHANNEL_ID: '',
    DEFAULT_PHONE_REGION: 'US',
    DATABASE_URL: 'postgres://localhost/test',
    DATABASE_SSL: 'disable',
    CREATE_CONTACT_FROM_CALL: false,
    ENABLE_MERGE_ENDPOINT: false,
    MAX_RETRIES: 6,
    PORT: 3000,
    HOST: '0.0.0.0',
    LOG_LEVEL: 'silent',
    RUN_WORKER_IN_WEB: true,
    WORKER_POLL_INTERVAL_MS: 2000,
    ...overrides,
  };
}

interface TestMocks {
  repo: {
    getProcessedCall: jest.Mock;
    recordProcessedCall: jest.Mock;
    upsertMapping: jest.Mock;
    getMappingByAircallContact: jest.Mock;
    getMappingByPhone: jest.Mock;
    getProcessedEstimate: jest.Mock;
    recordProcessedEstimate: jest.Mock;
  };
  aircall: {
    getCall: jest.Mock;
    downloadRecording: jest.Mock;
    searchContactByPhone: jest.Mock;
    createContact: jest.Mock;
    updateContact: jest.Mock;
  };
  jobnimbus: {
    findContactsByPhone: jest.Mock;
    getRelatedJobs: jest.Mock;
    getContact: jest.Mock;
    createActivity: jest.Mock;
    uploadFile: jest.Mock;
    createContact: jest.Mock;
    updateContact: jest.Mock;
    archiveContact: jest.Mock;
    getEstimate: jest.Mock;
  };
  slack: { enabled: boolean; postShoutout: jest.Mock };
}

/** Build an AppContext with jest-mocked clients/repo for flow tests. */
export function buildTestCtx(overrides: Partial<Config> = {}): {
  ctx: AppContext;
  mocks: TestMocks;
} {
  const config = testConfig(overrides);
  const logger = pino({ level: 'silent' });

  const repo = {
    getProcessedCall: jest.fn().mockResolvedValue(null),
    recordProcessedCall: jest.fn().mockResolvedValue(undefined),
    upsertMapping: jest.fn().mockResolvedValue(undefined),
    getMappingByAircallContact: jest.fn().mockResolvedValue([]),
    getMappingByPhone: jest.fn().mockResolvedValue([]),
    getProcessedEstimate: jest.fn().mockResolvedValue(null),
    recordProcessedEstimate: jest.fn().mockResolvedValue(undefined),
  };

  const aircall = {
    getCall: jest.fn(),
    downloadRecording: jest.fn(),
    searchContactByPhone: jest.fn().mockResolvedValue([]),
    createContact: jest.fn().mockResolvedValue({ id: 555001 }),
    updateContact: jest.fn().mockResolvedValue({ id: 555001 }),
  };

  const jobnimbus = {
    findContactsByPhone: jest.fn().mockResolvedValue([]),
    getRelatedJobs: jest.fn().mockResolvedValue([]),
    getContact: jest.fn(),
    createActivity: jest.fn().mockResolvedValue({ jnid: 'act_1' }),
    uploadFile: jest.fn().mockResolvedValue({ jnid: 'file_1' }),
    createContact: jest.fn().mockResolvedValue({ jnid: 'new_contact' }),
    updateContact: jest.fn().mockResolvedValue({ jnid: 'existing' }),
    archiveContact: jest.fn().mockResolvedValue({ jnid: 'archived' }),
    getEstimate: jest.fn(),
  };

  const slack = {
    enabled: true,
    postShoutout: jest.fn().mockResolvedValue({ ts: '123.456' }),
  };

  const ctx = {
    config,
    logger,
    repo: repo as never,
    aircall: aircall as never,
    jobnimbus: jobnimbus as never,
    slack: slack as never,
  } as AppContext;

  return { ctx, mocks: { repo, aircall, jobnimbus, slack } satisfies TestMocks };
}
