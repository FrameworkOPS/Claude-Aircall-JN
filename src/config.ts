import { z } from 'zod';

/**
 * Centralised, validated configuration. Everything comes from the environment
 * (Railway env vars) — no secrets in code. Import `loadConfig()` once at boot.
 */

const csv = (def: string) =>
  z
    .string()
    .default(def)
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    );

const bool = (def: string) =>
  z
    .string()
    .default(def)
    .transform((s) => s.toLowerCase() === 'true' || s === '1');

const ConfigSchema = z.object({
  // Aircall
  AIRCALL_API_ID: z.string().min(1),
  AIRCALL_API_TOKEN: z.string().min(1),
  AIRCALL_BASE_URL: z.string().url().default('https://api.aircall.io/v1'),
  AIRCALL_WEBHOOK_SECRET: z.string().min(1),
  AIRCALL_VERIFY_HMAC: bool('false'),
  AIRCALL_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(60),
  // Minutes (comma separated) to wait/retry for a recording to become available
  // after call.ended before giving up.
  RECORDING_POLL_SCHEDULE_MIN: csv('1,3,5,10').pipe(z.array(z.coerce.number().positive())),

  // JobNimbus
  JOBNIMBUS_API_KEY: z.string().min(1),
  JOBNIMBUS_BASE_URL: z.string().url().default('https://app.jobnimbus.com/api1'),
  JOBNIMBUS_WEBHOOK_SECRET: z.string().min(1),
  JOBNIMBUS_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(100),
  ESTIMATE_SIGNED_STATUSES: csv('signed,complete,completed').pipe(
    z.array(z.string().transform((s) => s.toLowerCase())),
  ),
  ATTACH_TARGET: z.enum(['job', 'contact', 'both']).default('job'),

  // Slack
  SLACK_BOT_TOKEN: z.string().default(''),
  SLACK_CHANNEL_ID: z.string().default(''),

  // Phone
  DEFAULT_PHONE_REGION: z.string().default('US'),

  // Database
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: z.enum(['disable', 'require']).default('disable'),

  // Flags
  CREATE_CONTACT_FROM_CALL: bool('false'),
  ENABLE_MERGE_ENDPOINT: bool('false'),
  MAX_RETRIES: z.coerce.number().int().positive().default(6),

  // Runtime
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  RUN_WORKER_IN_WEB: bool('true'),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
});

export type Config = z.infer<typeof ConfigSchema>;

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  // Slack is required only if you intend to use the estimate-signed flow.
  if (parsed.data.SLACK_BOT_TOKEN && !parsed.data.SLACK_CHANNEL_ID) {
    throw new Error('SLACK_BOT_TOKEN set but SLACK_CHANNEL_ID is missing.');
  }
  cached = parsed.data;
  return cached;
}

/** Test helper to reset the memoised config. */
export function resetConfigCache(): void {
  cached = undefined;
}
