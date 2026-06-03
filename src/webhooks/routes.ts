import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import {
  AircallWebhookSchema,
  JobNimbusEstimateWebhookSchema,
  JobNimbusJobWebhookSchema,
  extractEstimate,
  extractJobContact,
} from './schema';
import { verifyAircall, safeEqual } from '../lib/verify';
import type { RecordingJobPayload } from '../flows/recording';
import type { CallIntakePayload } from '../flows/callIntake';
import type { AircallContactPushPayload } from '../flows/aircallContactPush';

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

  // Flow B — JobNimbus "job created" automation -> push the customer's name to Aircall.
  app.post('/webhooks/jobnimbus/job', async (req: RawBodyRequest, reply) => {
    const provided =
      (req.headers['x-webhook-secret'] as string | undefined) ??
      (req.query as { secret?: string } | undefined)?.secret ??
      '';
    if (!safeEqual(provided, config.JOBNIMBUS_WEBHOOK_SECRET)) {
      logger.warn('rejected unauthenticated JobNimbus job webhook');
      return reply.code(401).send({ error: 'unauthenticated' });
    }

    const parsed = JobNimbusJobWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn({ issues: parsed.error.issues }, 'invalid JobNimbus job webhook payload');
      return reply.code(400).send({ error: 'invalid payload' });
    }
    await repo.saveWebhookEvent('jobnimbus', 'job.created', parsed.data, null);

    const { contactJnid, phone, firstName, lastName } = extractJobContact(parsed.data);
    if (!contactJnid && !phone) {
      logger.warn('JobNimbus job webhook missing contact jnid and phone; ignoring');
      return reply.code(200).send({ ok: true, ignored: 'no contact reference' });
    }

    const payload: AircallContactPushPayload = {
      jobnimbus_contact_jnid: contactJnid ?? undefined,
      phone: phone ?? undefined,
      first_name: firstName ?? undefined,
      last_name: lastName ?? undefined,
    };
    await repo.enqueueJob({
      type: 'aircall_contact_push',
      payload: payload as unknown as Record<string, unknown>,
      maxAttempts: config.MAX_RETRIES,
    });
    logger.info({ contactJnid, phone_present: Boolean(phone) }, 'enqueued Aircall contact push');
    return reply.code(200).send({ ok: true });
  });
}

async function routeAircallEvent(
  ctx: AppContext,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  const { config, logger, repo } = ctx;

  // NOTE: contact.created/updated are intentionally NOT handled. This service
  // now WRITES Aircall contacts (Flow B), so echoing those events back into
  // JobNimbus would create a sync loop. The Aircall webhook should only
  // subscribe to call.created + call.ended.

  // SMS events -> log the message into the JN contact's most-recent job.
  // Aircall fires `message.received` (inbound) and `message.sent` (outbound).
  // `message.status_updated` is just delivery-state churn; ignore it.
  if (event === 'message.received' || event === 'message.sent') {
    const smsId = (data.id ?? data.sms_id) as number | string | undefined;
    if (!smsId) {
      logger.debug({ event }, 'Aircall SMS event without message id; stored only');
      return;
    }
    const direction = event === 'message.received' ? 'inbound' : 'outbound';
    // Aircall sends `from`/`to` as either a string or an object {value:'+1...'}.
    const phoneOf = (v: unknown): string => {
      if (typeof v === 'string') return v;
      if (v && typeof v === 'object' && 'value' in v && typeof (v as { value: unknown }).value === 'string') {
        return (v as { value: string }).value;
      }
      return '';
    };
    const payload = {
      sms_id: smsId,
      direction,
      // Aircall has used both `body` and `content` historically — try both.
      body: String(data.body ?? data.content ?? data.text ?? ''),
      from: phoneOf(data.from),
      to: phoneOf(data.to),
      agent_name: (data.user as { name?: string } | undefined)?.name,
      created_at: data.created_at as number | undefined,
    };
    await repo.enqueueJob({
      type: 'sms_log',
      payload: payload as unknown as Record<string, unknown>,
      dedupeKey: `sms:${smsId}`,
      maxAttempts: config.MAX_RETRIES,
    });
    return;
  }

  const callId = data.id as number | string | undefined;
  if (!callId) {
    logger.debug({ event }, 'Aircall event without call id; stored only');
    return;
  }

  // call.created -> ensure a JobNimbus contact (stub/dedup/merge) for the caller.
  if (event === 'call.created') {
    const payload: CallIntakePayload = {
      call_id: callId,
      phone: String(data.raw_digits ?? ''),
      direction: data.direction as 'inbound' | 'outbound' | undefined,
    };
    await repo.enqueueJob({
      type: 'call_intake',
      payload: payload as unknown as Record<string, unknown>,
      dedupeKey: `call_intake:${callId}`,
      maxAttempts: config.MAX_RETRIES,
    });
    return;
  }

  // call.ended -> upload the recording to the matched contact's job/contact.
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
