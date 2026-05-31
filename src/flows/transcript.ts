import type { AppContext } from '../context';
import { NotReadyError } from '../context';
import { normalizePhone, last4 } from '../lib/phone';

export interface TranscriptJobPayload {
  call_id: number | string;
  /** 'event' = arrived via transcription.created; 'poll' = polling after call.ended. */
  source: 'event' | 'poll';
}

/**
 * Flatten Aircall's transcription payload to plain text. The exact shape is not
 * fully documented, so this tolerates several plausible layouts. (Risk isolated
 * here per FINDINGS.md.)
 */
export function flattenTranscript(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw.trim();

  const obj = raw as Record<string, unknown>;
  const content = (obj.transcription as Record<string, unknown>)?.content ?? obj.content ?? obj;

  // Shape A: { utterances: [{ speaker, text }] } or { sentences: [...] }
  const c = content as Record<string, unknown>;
  const list = (c.utterances ?? c.sentences ?? (Array.isArray(content) ? content : undefined)) as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(list)) {
    return list
      .map((u) => {
        const speaker = u.speaker ?? u.participant_type ?? u.party;
        const text = u.text ?? u.content ?? u.words ?? '';
        return speaker ? `${String(speaker)}: ${String(text)}` : String(text);
      })
      .filter((l) => l.trim() !== '')
      .join('\n');
  }

  // Shape B: { text: "..." }
  if (typeof c.text === 'string') return c.text.trim();
  return '';
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
 * Flow 2 — transcript + recording -> JobNimbus.
 *
 * 1. Idempotency: skip if call already processed.
 * 2. Fetch authoritative call metadata (recording URL, direction, agent, phone).
 * 3. Fetch transcript; if not ready and we're polling, defer (NotReadyError).
 * 4. Match a JobNimbus contact by the external party's normalized phone.
 * 5. Resolve target(s): related job(s) preferred, contact as fallback (config).
 * 6. Post a machine-tagged note, then upload the recording file to each target.
 * 7. Record processed_calls. Never create a contact from a transcript unless
 *    CREATE_CONTACT_FROM_TRANSCRIPT is on.
 */
export async function processTranscript(ctx: AppContext, payload: TranscriptJobPayload): Promise<void> {
  const { logger, repo, aircall, jobnimbus, config } = ctx;
  const callId = String(payload.call_id);
  const log = logger.child({ flow: 'transcript', call_id: callId });

  const existing = await repo.getProcessedCall(callId);
  if (existing && (existing.transcript_posted_at || existing.outcome === 'no_contact_match')) {
    log.info({ outcome: existing.outcome }, 'call already processed; skipping');
    return;
  }

  const call = await aircall.getCall(callId);
  const e164 = normalizePhone(call.raw_digits, config.DEFAULT_PHONE_REGION);
  const phoneLog = { phone_last4: last4(call.raw_digits), direction: call.direction };

  const rawTranscript = await aircall.getTranscription(callId);
  const transcript = flattenTranscript(rawTranscript);
  if (!transcript) {
    if (payload.source === 'poll') {
      throw new NotReadyError('transcript not ready yet');
    }
    // Event said it was ready but we got nothing — treat as not ready, defer.
    throw new NotReadyError('transcription.created received but transcript empty');
  }

  if (!e164) {
    log.warn(phoneLog, 'NO_CONTACT_MATCH: unparseable external phone');
    await repo.recordProcessedCall({
      aircall_call_id: callId,
      normalized_phone: null,
      jobnimbus_jnid: null,
      jobnimbus_activity_id: null,
      jobnimbus_file_id: null,
      transcript_posted: false,
      recording_uploaded: false,
      outcome: 'no_contact_match',
    });
    return;
  }

  const contacts = await jobnimbus.findContactsByPhone(e164);

  if (contacts.length === 0) {
    if (config.CREATE_CONTACT_FROM_TRANSCRIPT) {
      const created = await jobnimbus.createContact({ mobile_phone: e164, display_name: call.raw_digits });
      contacts.push(created);
      log.info({ ...phoneLog, jnid: created.jnid }, 'created minimal contact from transcript (config-gated)');
    } else {
      log.warn(phoneLog, 'NO_CONTACT_MATCH: no JobNimbus contact for phone');
      await repo.recordProcessedCall({
        aircall_call_id: callId,
        normalized_phone: e164,
        jobnimbus_jnid: null,
        jobnimbus_activity_id: null,
        jobnimbus_file_id: null,
        transcript_posted: false,
        recording_uploaded: false,
        outcome: 'no_contact_match',
      });
      return;
    }
  }

  if (contacts.length > 1) {
    log.warn(
      { ...phoneLog, jnids: contacts.map((c) => c.jnid) },
      'DUPLICATE_CONFLICT: multiple contacts match phone; skipping write',
    );
    await repo.recordProcessedCall({
      aircall_call_id: callId,
      normalized_phone: e164,
      jobnimbus_jnid: null,
      jobnimbus_activity_id: null,
      jobnimbus_file_id: null,
      transcript_posted: false,
      recording_uploaded: false,
      outcome: 'duplicate_conflict',
    });
    return;
  }

  const contact = contacts[0]!;
  const targets = await resolveTargets(ctx, contact.jnid);

  const header =
    `[Aircall Transcript]\n` +
    `Direction: ${call.direction}\n` +
    `Time: ${isoFromEpoch(call.started_at)}\n` +
    `Duration: ${formatDuration(call.duration)}\n` +
    `Agent: ${call.user?.name ?? 'unknown'}\n` +
    `Aircall call ID: ${callId}\n\n`;
  const note = header + transcript;

  let activityId: string | null = null;
  let fileId: string | null = null;

  // Download recording once; reuse the buffer for each target.
  let recording: { buffer: Buffer; contentType: string } | null = null;
  if (call.recording) {
    try {
      recording = await aircall.downloadRecording(call.recording);
    } catch (err) {
      log.warn({ err: String(err) }, 'recording download failed; posting note without audio');
    }
  }

  for (const t of targets) {
    const activity = await jobnimbus.createActivity({
      relatedId: t.id,
      relatedType: t.type,
      note,
    });
    activityId = activityId ?? activity.jnid;

    if (recording) {
      const uploaded = await jobnimbus.uploadFile({
        relatedId: t.id,
        relatedType: t.type,
        filename: `aircall-call-${callId}.mp3`,
        buffer: recording.buffer,
        contentType: recording.contentType,
        description: `[Aircall Recording] ${call.direction} call ${isoFromEpoch(call.started_at)}`,
      });
      fileId = fileId ?? uploaded.jnid;
    }
  }

  await repo.recordProcessedCall({
    aircall_call_id: callId,
    normalized_phone: e164,
    jobnimbus_jnid: targets[0]?.id ?? contact.jnid,
    jobnimbus_activity_id: activityId,
    jobnimbus_file_id: fileId,
    transcript_posted: true,
    recording_uploaded: recording !== null,
    outcome: 'posted',
  });

  log.info(
    {
      ...phoneLog,
      targets: targets.map((t) => `${t.type}:${t.id}`),
      recording: recording !== null,
    },
    'transcript posted to JobNimbus',
  );
}

/** Decide where the note/recording land based on ATTACH_TARGET. */
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
