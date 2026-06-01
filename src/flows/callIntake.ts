import type { AppContext } from '../context';
import { normalizePhone, last4 } from '../lib/phone';
import { resolveCanonicalContact } from './dedupe';

export interface CallIntakePayload {
  call_id: number | string;
  /** The external party's number as Aircall reports it (raw_digits). */
  phone: string;
  direction?: 'inbound' | 'outbound';
}

/**
 * Flow A — call.created -> ensure a JobNimbus contact exists for the caller.
 *
 * On every call (inbound or outbound), normalize the external number and make
 * sure exactly one JobNimbus contact owns it: reuse an existing one, create an
 * "Aircall / <E.164>" stub if none, or run the safe auto-merge when several
 * already match. Creating it on call.created surfaces the caller in JobNimbus
 * while the call is still happening.
 */
export async function processCallIntake(ctx: AppContext, payload: CallIntakePayload): Promise<void> {
  const { logger, config } = ctx;
  const log = logger.child({ flow: 'call_intake', call_id: String(payload.call_id) });

  const e164 = normalizePhone(payload.phone, config.DEFAULT_PHONE_REGION);
  if (!e164) {
    log.warn({ direction: payload.direction }, 'call has no parseable external phone; skipping');
    return;
  }

  const { contact, outcome } = await resolveCanonicalContact(ctx, e164, {
    createStubIfMissing: true,
  });
  log.info(
    { phone_last4: last4(e164), direction: payload.direction, outcome, jnid: contact?.jnid },
    'call intake resolved JobNimbus contact',
  );
}
