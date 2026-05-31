import { processTranscript } from '../src/flows/transcript';
import { NotReadyError } from '../src/context';
import { buildTestCtx } from './support';

const baseCall = {
  id: 999,
  direction: 'inbound' as const,
  raw_digits: '+1 208-555-1234',
  started_at: 1_700_000_000,
  answered_at: 1_700_000_010,
  ended_at: 1_700_000_120,
  duration: 120,
  recording: 'https://recordings.aircall.io/999.mp3',
  user: { id: 1, name: 'Jane Agent' },
};

describe('processTranscript (Flow 2)', () => {
  it('posts note + uploads recording to the related job when a contact matches', async () => {
    const { ctx, mocks } = buildTestCtx({ ATTACH_TARGET: 'job' });
    mocks.aircall.getCall.mockResolvedValue(baseCall);
    mocks.aircall.getTranscription.mockResolvedValue({ content: { text: 'leaky roof discussion' } });
    mocks.aircall.downloadRecording.mockResolvedValue({ buffer: Buffer.from('audio'), contentType: 'audio/mpeg' });
    mocks.jobnimbus.findContactsByPhone.mockResolvedValue([{ jnid: 'contact_1' }]);
    mocks.jobnimbus.getRelatedJobs.mockResolvedValue([{ jnid: 'job_7' }]);

    await processTranscript(ctx, { call_id: 999, source: 'event' });

    expect(mocks.jobnimbus.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({ relatedId: 'job_7', relatedType: 'job' }),
    );
    const note = mocks.jobnimbus.createActivity.mock.calls[0][0].note as string;
    expect(note).toContain('[Aircall Transcript]');
    expect(note).toContain('leaky roof discussion');
    expect(mocks.jobnimbus.uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ relatedId: 'job_7', relatedType: 'job', filename: 'aircall-call-999.mp3' }),
    );
    expect(mocks.repo.recordProcessedCall).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'posted', transcript_posted: true, recording_uploaded: true }),
    );
  });

  it('falls back to the contact when there are no related jobs', async () => {
    const { ctx, mocks } = buildTestCtx({ ATTACH_TARGET: 'job' });
    mocks.aircall.getCall.mockResolvedValue({ ...baseCall, recording: null });
    mocks.aircall.getTranscription.mockResolvedValue('hello');
    mocks.jobnimbus.findContactsByPhone.mockResolvedValue([{ jnid: 'contact_1' }]);
    mocks.jobnimbus.getRelatedJobs.mockResolvedValue([]);

    await processTranscript(ctx, { call_id: 999, source: 'event' });

    expect(mocks.jobnimbus.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({ relatedId: 'contact_1', relatedType: 'contact' }),
    );
    expect(mocks.jobnimbus.uploadFile).not.toHaveBeenCalled();
  });

  it('records NO_CONTACT_MATCH and writes nothing when no contact matches', async () => {
    const { ctx, mocks } = buildTestCtx();
    mocks.aircall.getCall.mockResolvedValue(baseCall);
    mocks.aircall.getTranscription.mockResolvedValue('hello');
    mocks.jobnimbus.findContactsByPhone.mockResolvedValue([]);

    await processTranscript(ctx, { call_id: 999, source: 'event' });

    expect(mocks.jobnimbus.createActivity).not.toHaveBeenCalled();
    expect(mocks.repo.recordProcessedCall).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'no_contact_match' }),
    );
  });

  it('flags DUPLICATE_CONFLICT and writes nothing when multiple contacts match', async () => {
    const { ctx, mocks } = buildTestCtx();
    mocks.aircall.getCall.mockResolvedValue(baseCall);
    mocks.aircall.getTranscription.mockResolvedValue('hello');
    mocks.jobnimbus.findContactsByPhone.mockResolvedValue([{ jnid: 'a' }, { jnid: 'b' }]);

    await processTranscript(ctx, { call_id: 999, source: 'event' });

    expect(mocks.jobnimbus.createActivity).not.toHaveBeenCalled();
    expect(mocks.repo.recordProcessedCall).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'duplicate_conflict' }),
    );
  });

  it('defers (NotReadyError) when polling and transcript is not ready', async () => {
    const { ctx, mocks } = buildTestCtx();
    mocks.aircall.getCall.mockResolvedValue(baseCall);
    mocks.aircall.getTranscription.mockResolvedValue(null);

    await expect(processTranscript(ctx, { call_id: 999, source: 'poll' })).rejects.toBeInstanceOf(
      NotReadyError,
    );
    expect(mocks.jobnimbus.createActivity).not.toHaveBeenCalled();
  });

  it('is idempotent: skips a call already processed', async () => {
    const { ctx, mocks } = buildTestCtx();
    mocks.repo.getProcessedCall.mockResolvedValue({ transcript_posted_at: new Date(), outcome: 'posted' });

    await processTranscript(ctx, { call_id: 999, source: 'event' });

    expect(mocks.aircall.getCall).not.toHaveBeenCalled();
    expect(mocks.jobnimbus.createActivity).not.toHaveBeenCalled();
  });
});
