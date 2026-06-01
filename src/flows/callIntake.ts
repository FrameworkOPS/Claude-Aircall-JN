import type { AppContext } from '../context';
import type { JnContact } from '../clients/jobnimbus';
import { normalizePhone, last4 } from '../lib/phone';
import { resolveCanonicalContact, isStub } from './dedupe';

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

  // Push an Insight Card so the agent's softphone shows who's calling, even if
  // Aircall's contact sync is stale. Best-effort; failure is logged + swallowed.
  if (contact) {
    await pushCallerCard(ctx, payload.call_id, contact, e164);
  }
}

async function pushCallerCard(
  ctx: AppContext,
  callId: number | string,
  contact: JnContact,
  e164: string,
): Promise<void> {
  const { aircall, jobnimbus, logger } = ctx;

  const first = String(contact.first_name ?? '').trim();
  const last = String(contact.last_name ?? '').trim();
  const display = (contact.display_name as string | undefined)?.trim() || `${first} ${last}`.trim();
  const stub = isStub(contact);
  const contactLink = `https://app.jobnimbus.com/contact/${contact.jnid}`;

  const contents: Array<Record<string, unknown>> = [
    {
      type: 'title',
      text: stub
        ? `New caller · ${e164}`
        : display || `Unknown · ${last4(e164)}`,
      link: contactLink,
    },
  ];

  // If JobNimbus has jobs for this contact, include the most recent as a click-through.
  try {
    const jobs = await jobnimbus.getRelatedJobs(contact.jnid);
    if (jobs.length > 0) {
      const j = jobs[0]!;
      contents.push({
        type: 'shortText',
        label: jobs.length > 1 ? `Job (${jobs.length} total)` : 'Job',
        text: String(j.name ?? j.display_name ?? 'Open job'),
        link: `https://app.jobnimbus.com/job/${j.jnid}`,
      });
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'failed to load related jobs for insight card');
  }

  if (stub) {
    contents.push({
      type: 'shortText',
      label: 'Status',
      text: 'Not yet in JobNimbus — stub created. Open to add real name.',
      link: contactLink,
    });
  }

  await aircall.pushInsightCard(callId, contents);
}
