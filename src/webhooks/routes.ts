import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { AircallWebhookSchema, JobNimbusEstimateWebhookSchema, extractEstimate } from './schema';
import { verifyAircall, safeEqual } from '../lib/verify';
import type { RecordingJobPayload } from '../flows/recording';
import type { AircallContactPayload } from '../flows/contactSync';

interface RawBodyRequest extends FastifyRequest {
  rawBody?: string;
}

/**
 * Register both webhook receivers. Each verifies authenticity, validates the
 * payload, persists the raw event, enqueues a job, and returns 200 immediately.
 * No slow work happens in the handler (per Aircall's guidance).
 */
export function registerWebhooks(app: FastifyInstance, ctx: AppContext): void {
  const { config, logger, repo } = ctx;

  app.post('/webhooks/aircall', async (req: RawBodyRequest, reply) => {
    const verdict = verifyAircall({
      rawBody: req.rawBody ?? '',
      bodyToken: (req.body as { token?: string } | undefined)?.token,
      signatureHeader: req.headers['x-aircall-signature'] as string | undefined,
      webhookSecret: config.AIRCALL_WEBHOOK_SECRET,
      apiToken: config.AIRCALL_API_TOKEN,
      verifyHmac: config.AIRCALL_VERIFY_HMAC,
    });
    if (!verdict.ok) {
      logger.warn({ reason: verdict.reason }, 'rejected unauthenticated Aircall webhook');
      return reply.code(401).send({ error: 'unauthenticated' });
    }

    const parsed = AircallWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn({ issues: parsed.error.issues }, 'invalid Aircall webhook payload');
      return reply.code(400).send({ error: 'invalid payload' });
    }
    const evt = parsed.data;
    await repo.saveWebhookEvent('aircall', evt.event, evt, req.headers['x-aircall-signature'] as string ?? null);

    await routeAircallEvent(ctx, evt.event, evt.data);
    return reply.code(200).send({ ok: true });
  });

  app.post('/webhooks/jobnimbus', async (req: RawBodyRequest, reply) => {
    const provided =
      (req.headers['x-webhook-secret'] as string | undefined) ??
      (req.query as { secret?: string } | undefined)?.secret ??
      '';
    if (!safeEqual(provided, config.JOBNIMBUS_WEBHOOK_SECRET)) {
      logger.warn('rejected unauthenticated JobNimbus webhook');
      return reply.code(401).send({ error: 'unauthenticated' });
    }

    const parsed = JobNimbusEstimateWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn({ issues: parsed.error.issues }, 'invalid JobNimbus webhook payload');
      return reply.code(400).send({ error: 'invalid payload' });
    }
    const { jnid, status, signed } = extractEstimate(parsed.data);
    await repo.saveWebhookEvent('jobnimbus', 'estimate.webhook', parsed.data, null);

    if (jnid && signed) {
      await repo.enqueueJob({
        type: 'estimate_shoutout',
        payload: { estimate_jnid: jnid, signed_status: status ?? undefined },
        dedupeKey: `estimate:${jnid}`,
        maxAttempts: config.MAX_RETRIES,
      });
      logger.info({ estimate_jnid: jnid }, 'enqueued estimate shoutout');
    } else {
      logger.info({ jnid, status, signed }, 'JobNimbus webhook ignored (not a signed estimate)');
    }
    return reply.code(200).send({ ok: true });
  });
}

async function routeAircallEvent(
  ctx: AppContext,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  const { config, logger, repo } = ctx;

  if (event === 'contact.created' || event === 'contact.updated') {
    const contact = data as unknown as AircallContactPayload;
    await repo.enqueueJob({
      type: 'contact_sync',
      payload: contact as unknown as Record<string, unknown>,
      dedupeKey: `contact_sync:${contact.id}:${Date.now()}`,
      maxAttempts: config.MAX_RETRIES,
    });
    return;
  }

  const callId = data.id as number | string | undefined;
  if (!callId) return;

  // call.ended fires once call data (including the recording) is gathered.
  if (event === 'call.ended') {
    const payload: RecordingJobPayload = { call_id: callId };
    await repo.enqueueJob({
      type: 'recording',
      payload: payload as unknown as Record<string, unknown>,
      dedupeKey: `recording:${callId}`,
      maxAttempts: config.MAX_RETRIES,
    });
    return;
  }

  logger.debug({ event }, 'no handler for Aircall event; stored only');
}
