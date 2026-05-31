import pino, { type Logger } from 'pino';

/**
 * Structured JSON logger. Never log full PII or full transcripts — use the
 * `last4` helper from lib/phone for phone numbers and keep bodies out of logs.
 */
export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: 'aircall-jobnimbus' },
    redact: {
      // Defensive redaction in case a raw object slips into a log call.
      paths: [
        'api_token',
        'api_id',
        'apiKey',
        'authorization',
        'headers.authorization',
        'transcript',
        'note',
        '*.transcript',
        '*.api_token',
      ],
      censor: '[redacted]',
    },
  });
}

export type { Logger };
