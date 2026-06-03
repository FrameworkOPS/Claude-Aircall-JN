import type { AppContext } from '../context';
import { normalizePhone, last4 } from '../lib/phone';
import { resolveCanonicalContact } from './dedupe';

/**
 * Flow D — log every Aircall SMS to JobNimbus.
 *
 * Aircall sends `message.received` (inbound) and `message.sent` (outbound) when
 * an SMS goes through any Aircall number. For each, we find the JN contact that
 * owns the external party's phone (creating a stub if none exists) and post the
 * SMS body as an activity note attached to that contact's most-recent related
 * job, falling back to the contact when there's no job.
 *
 * Idempotent via the worker's dedupe_key on `sms:<id>`.
 */
export interface SmsLogPayload {
  sms_id: string | number;
  /** From Aircall's message envelope — usually 'inbound' | 'outbound'. */
  direction?: string;
  /** Body / content of the SMS — Aircall sometimes uses either key. */
  body?: string;
  /** External party's phone (the customer). Best-effort, may be in from/to. */
  external_phone?: string;
  /** Inbound = 'from'; outbound = 'to'. Both kept in case external_phone is missing. */
  from?: string;
  to?: string;
  /** Optional agent name (outbound). */
  agent_name?: string;
  /** Unix seconds — when the SMS was created. */
  created_at?: number;
}

export async function logSms(ctx: AppContext, payload: SmsLogPayload): Promise<void> {
  const { logger, config, jobnimbus } = ctx;
  const log = logger.child({ flow: 'sms_log', sms_id: String(payload.sms_id) });

  // Pick the external party's phone. For inbound that's `from`; for outbound, `to`.
  const direction = (payload.direction ?? '').toLowerCase();
  const externalRaw =
    payload.external_phone ??
    (direction === 'outbound' ? payload.to : payload.from) ??
    payload.from ??
    payload.to ??
    '';
  const e164 = normalizePhone(String(externalRaw), config.DEFAULT_PHONE_REGION);
  if (!e164) {
    log.warn({ direction, externalRaw }, 'SMS has no parseable external phone; skipping');
    return;
  }

  const { contact } = await resolveCanonicalContact(ctx, e164, { createStubIfMissing: true });
  if (!contact) {
    log.warn({ phone_last4: last4(e164) }, 'could not resolve JN contact for SMS; skipping');
    return;
  }

  // Pick the right target: most-recent related job if any, else the contact.
  let targetId = contact.jnid;
  let targetType: 'contact' | 'job' = 'contact';
  try {
    const jobs = await jobnimbus.getRelatedJobs(contact.jnid);
    if (jobs.length > 0) {
      targetId = jobs[0]!.jnid;
      targetType = 'job';
    }
  } catch (err) {
    log.warn({ err: String(err) }, 'related jobs lookup failed; falling back to contact');
  }

  const when = payload.created_at
    ? new Date(payload.created_at * 1000).toISOString()
    : new Date().toISOString();
  const body = String(payload.body ?? '').trim();
  const dirLabel = direction === 'outbound' ? 'outbound' : direction === 'inbound' ? 'inbound' : 'unknown';
  const agentLine = payload.agent_name ? `\nAgent: ${payload.agent_name}` : '';

  const note =
    `[Aircall SMS · ${dirLabel}]\n` +
    `Time: ${when}\n` +
    `Phone: ${e164}` +
    agentLine +
    `\n` +
    `\n${body || '(empty SMS body)'}`;

  await jobnimbus.createActivity({
    relatedId: targetId,
    relatedType: targetType,
    note,
  });

  log.info(
    { phone_last4: last4(e164), direction: dirLabel, target: `${targetType}:${targetId}`, body_len: body.length },
    'logged Aircall SMS to JobNimbus',
  );
}
