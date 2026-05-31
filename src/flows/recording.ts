import type { AppContext } from '../context';
import { NotReadyError } from '../context';
import { normalizePhone, last4 } from '../lib/phone';

export interface RecordingJobPayload {
  call_id: number | string;
}

function isoFromEpoch(epoch: number | null | undefined): string {
  if (!epoch) return 'unknown time';
  return new Date(epoch * 1000).toISOString();
}

function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '0s';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * Flow 2 — call recording -> JobNimbus.
 *
 * 1. Idempotency: skip if the call's recording was already uploaded.
 * 2. Fetch authoritative call metadata (recording URL, direction, agent, phone).
 * 3. If the recording isn't ready yet, defer (NotReadyError) and retry per
 *    RECORDING_POLL_SCHEDULE_MIN; give up after the schedule is exhausted.
 * 4. Match a JobNimbus contact by the external party's normalized phone.
 * 5. Resolve target(s): related job(s) preferred, contact as fallback (config).
 * 6. Upload the recording file to each target, with a short context note.
 * 7. Record processed_calls. Never create a contact from a call unless
 *    CREATE_CONTACT_FROM_CALL is on.
 */
export async function processRecording(ctx: AppContext, payload: RecordingJobPayload): Promise<void> {
  const { logger, repo, aircall, jobnimbus, config } = ctx;
  const callId = String(payload.call_id);
  const log = logger.child({ flow: 'recording', call_id: callId });

  const existing = await repo.getProcessedCall(callId);
  if (existing && (existing.recording_uploaded_at || existing.outcome === 'no_contact_match')) {
    log.info({ outcome: existing.outcome }, 'call already processed; skipping');
    return;
  }

  const call = await aircall.getCall(callId);
  const phoneLog = { phone_last4: last4(call.raw_digits), direction: call.direction };

  if (!call.recording) {
    // Recording may still be processing; let the worker defer + retry.
    throw new NotReadyError('recording not available yet');
  }

  const e164 = normalizePhone(call.raw_digits, config.DEFAULT_PHONE_REGION);
  if (!e164) {
    log.warn(phoneLog, 'NO_CONTACT_MATCH: unparseable external phone');
    await recordOutcome(ctx, callId, null, 'no_contact_match');
    return;
  }

  const contacts = await jobnimbus.findContactsByPhone(e164);

  if (contacts.length === 0) {
    if (config.CREATE_CONTACT_FROM_CALL) {
      const created = await jobnimbus.createContact({ mobile_phone: e164, display_name: call.raw_digits });
      contacts.push(created);
      log.info({ ...phoneLog, jnid: created.jnid }, 'created minimal contact from call (config-gated)');
    } else {
      log.warn(phoneLog, 'NO_CONTACT_MATCH: no JobNimbus contact for phone');
      await recordOutcome(ctx, callId, e164, 'no_contact_match');
      return;
    }
  }

  if (contacts.length > 1) {
    log.warn(
      { ...phoneLog, jnids: contacts.map((c) => c.jnid) },
      'DUPLICATE_CONFLICT: multiple contacts match phone; skipping write',
    );
    await recordOutcome(ctx, callId, e164, 'duplicate_conflict');
    return;
  }

  const contact = contacts[0]!;
  const targets = await resolveTargets(ctx, contact.jnid);

  // Download the recording once; reuse the buffer for each target.
  const recording = await aircall.downloadRecording(call.recording);

  const note =
    `[Aircall Recording]\n` +
    `Direction: ${call.direction}\n` +
    `Time: ${isoFromEpoch(call.started_at)}\n` +
    `Duration: ${formatDuration(call.duration)}\n` +
    `Agent: ${call.user?.name ?? 'unknown'}\n` +
    `Aircall call ID: ${callId}\n` +
    `(recording attached)`;

  let activityId: string | null = null;
  let fileId: string | null = null;

  for (const t of targets) {
    const uploaded = await jobnimbus.uploadFile({
      relatedId: t.id,
      relatedType: t.type,
      filename: `aircall-call-${callId}.mp3`,
      buffer: recording.buffer,
      contentType: recording.contentType,
      description: `[Aircall Recording] ${call.direction} call ${isoFromEpoch(call.started_at)}`,
    });
    fileId = fileId ?? uploaded.jnid;

    const activity = await jobnimbus.createActivity({
      relatedId: t.id,
      relatedType: t.type,
      note,
    });
    activityId = activityId ?? activity.jnid;
  }

  await repo.recordProcessedCall({
    aircall_call_id: callId,
    normalized_phone: e164,
    jobnimbus_jnid: targets[0]?.id ?? contact.jnid,
    jobnimbus_activity_id: activityId,
    jobnimbus_file_id: fileId,
    recording_uploaded: true,
    outcome: 'posted',
  });

  log.info(
    { ...phoneLog, targets: targets.map((t) => `${t.type}:${t.id}`) },
    'recording uploaded to JobNimbus',
  );
}

async function recordOutcome(
  ctx: AppContext,
  callId: string,
  e164: string | null,
  outcome: string,
): Promise<void> {
  await ctx.repo.recordProcessedCall({
    aircall_call_id: callId,
    normalized_phone: e164,
    jobnimbus_jnid: null,
    jobnimbus_activity_id: null,
    jobnimbus_file_id: null,
    recording_uploaded: false,
    outcome,
  });
}

/** Decide where the recording/note land based on ATTACH_TARGET. */
async function resolveTargets(
  ctx: AppContext,
  contactJnid: string,
): Promise<Array<{ id: string; type: 'contact' | 'job' }>> {
  const { config, jobnimbus, logger } = ctx;
  const contactTarget = { id: contactJnid, type: 'contact' as const };

  if (config.ATTACH_TARGET === 'contact') return [contactTarget];

  const jobs = await jobnimbus.getRelatedJobs(contactJnid);
  const jobTargets = jobs.map((j) => ({ id: j.jnid, type: 'job' as const }));

  if (config.ATTACH_TARGET === 'both') {
    return [contactTarget, ...jobTargets];
  }

  // ATTACH_TARGET === 'job': prefer related jobs, fall back to the contact.
  if (jobTargets.length === 0) {
    logger.info({ contactJnid }, 'no related jobs; falling back to contact');
    return [contactTarget];
  }
  return jobTargets;
}
