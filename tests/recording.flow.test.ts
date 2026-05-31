import { processRecording } from '../src/flows/recording';
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

describe('processRecording (Flow 2)', () => {
  it('uploads the recording to the related job when a contact matches', async () => {
    const { ctx, mocks } = buildTestCtx({ ATTACH_TARGET: 'job' });
    mocks.aircall.getCall.mockResolvedValue(baseCall);
    mocks.aircall.downloadRecording.mockResolvedValue({ buffer: Buffer.from('audio'), contentType: 'audio/mpeg' });
    mocks.jobnimbus.findContactsByPhone.mockResolvedValue([{ jnid: 'contact_1' }]);
    mocks.jobnimbus.getRelatedJobs.mockResolvedValue([{ jnid: 'job_7' }]);

    await processRecording(ctx, { call_id: 999 });

    expect(mocks.jobnimbus.uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ relatedId: 'job_7', relatedType: 'job', filename: 'aircall-call-999.mp3' }),
    );
    const note = mocks.jobnimbus.createActivity.mock.calls[0][0].note as string;
    expect(note).toContain('[Aircall Recording]');
    expect(note).toContain('Agent: Jane Agent');
    expect(mocks.repo.recordProcessedCall).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'posted', recording_uploaded: true }),
    );
  });

  it('falls back to the contact when there are no related jobs', async () => {
    const { ctx, mocks } = buildTestCtx({ ATTACH_TARGET: 'job' });
    mocks.aircall.getCall.mockResolvedValue(baseCall);
    mocks.aircall.downloadRecording.mockResolvedValue({ buffer: Buffer.from('audio'), contentType: 'audio/mpeg' });
    mocks.jobnimbus.findContactsByPhone.mockResolvedValue([{ jnid: 'contact_1' }]);
    mocks.jobnimbus.getRelatedJobs.mockResolvedValue([]);

    await processRecording(ctx, { call_id: 999 });

    expect(mocks.jobnimbus.uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ relatedId: 'contact_1', relatedType: 'contact' }),
    );
  });

  it('defers (NotReadyError) when the recording is not available yet', async () => {
    const { ctx, mocks } = buildTestCtx();
    mocks.aircall.getCall.mockResolvedValue({ ...baseCall, recording: null });

    await expect(processRecording(ctx, { call_id: 999 })).rejects.toBeInstanceOf(NotReadyError);
    expect(mocks.jobnimbus.uploadFile).not.toHaveBeenCalled();
  });

  it('records NO_CONTACT_MATCH and writes nothing when no contact matches', async () => {
    const { ctx, mocks } = buildTestCtx();
    mocks.aircall.getCall.mockResolvedValue(baseCall);
    mocks.jobnimbus.findContactsByPhone.mockResolvedValue([]);

    await processRecording(ctx, { call_id: 999 });

    expect(mocks.aircall.downloadRecording).not.toHaveBeenCalled();
    expect(mocks.jobnimbus.uploadFile).not.toHaveBeenCalled();
    expect(mocks.repo.recordProcessedCall).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'no_contact_match' }),
    );
  });

  it('flags DUPLICATE_CONFLICT and writes nothing when multiple contacts match', async () => {
    const { ctx, mocks } = buildTestCtx();
    mocks.aircall.getCall.mockResolvedValue(baseCall);
    mocks.jobnimbus.findContactsByPhone.mockResolvedValue([{ jnid: 'a' }, { jnid: 'b' }]);

    await processRecording(ctx, { call_id: 999 });

    expect(mocks.jobnimbus.uploadFile).not.toHaveBeenCalled();
    expect(mocks.repo.recordProcessedCall).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'duplicate_conflict' }),
    );
  });

  it('is idempotent: skips a call whose recording was already uploaded', async () => {
    const { ctx, mocks } = buildTestCtx();
    mocks.repo.getProcessedCall.mockResolvedValue({ recording_uploaded_at: new Date(), outcome: 'posted' });

    await processRecording(ctx, { call_id: 999 });

    expect(mocks.aircall.getCall).not.toHaveBeenCalled();
    expect(mocks.jobnimbus.uploadFile).not.toHaveBeenCalled();
  });
});
