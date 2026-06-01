import { resolveCanonicalContact } from '../src/flows/dedupe';
import { buildTestCtx } from './support';

const PHONE = '+12085551234';

describe('resolveCanonicalContact (dedup + safe auto-merge)', () => {
  it('creates an "Aircall / <E.164>" stub when no contact matches', async () => {
    const { ctx, mocks } = buildTestCtx();
    mocks.jobnimbus.findContactsByPhone.mockResolvedValue([]);
    mocks.jobnimbus.createContact.mockResolvedValue({ jnid: 'stub', first_name: 'Aircall' });

    const r = await resolveCanonicalContact(ctx, PHONE, { createStubIfMissing: true });

    expect(r.outcome).toBe('created_stub');
    expect(mocks.jobnimbus.createContact).toHaveBeenCalledWith(
      expect.objectContaining({ first_name: 'Aircall', last_name: PHONE, mobile_phone: PHONE }),
    );
  });

  it('does not create when createStubIfMissing is false', async () => {
    const { ctx, mocks } = buildTestCtx();
    mocks.jobnimbus.findContactsByPhone.mockResolvedValue([]);

    const r = await resolveCanonicalContact(ctx, PHONE, { createStubIfMissing: false });

    expect(r.outcome).toBe('none');
    expect(r.contact).toBeNull();
    expect(mocks.jobnimbus.createContact).not.toHaveBeenCalled();
  });

  it('reuses the single existing contact (no duplicate created)', async () => {
    const { ctx, mocks } = buildTestCtx();
    mocks.jobnimbus.findContactsByPhone.mockResolvedValue([{ jnid: 'c1', first_name: 'Jane' }]);

    const r = await resolveCanonicalContact(ctx, PHONE, { createStubIfMissing: true });

    expect(r.outcome).toBe('matched');
    expect(r.contact?.jnid).toBe('c1');
    expect(mocks.jobnimbus.createContact).not.toHaveBeenCalled();
  });

  it('merges: archives an empty stub duplicate and keeps the real primary', async () => {
    const { ctx, mocks } = buildTestCtx();
    mocks.jobnimbus.findContactsByPhone.mockResolvedValue([
      { jnid: 'stub', first_name: 'Aircall', last_name: PHONE },
      { jnid: 'real', first_name: 'Jane', last_name: 'Doe' },
    ]);
    mocks.jobnimbus.getRelatedJobs.mockResolvedValue([]); // neither has jobs

    const r = await resolveCanonicalContact(ctx, PHONE, { createStubIfMissing: true });

    expect(r.outcome).toBe('merged');
    expect(r.contact?.jnid).toBe('real');
    expect(mocks.jobnimbus.archiveContact).toHaveBeenCalledWith('stub');
  });

  it('flags manual review when two real/with-job contacts collide (never archives them)', async () => {
    const { ctx, mocks } = buildTestCtx();
    mocks.jobnimbus.findContactsByPhone.mockResolvedValue([
      { jnid: 'r1', first_name: 'Jane', last_name: 'Doe' },
      { jnid: 'r2', first_name: 'John', last_name: 'Smith' },
    ]);
    mocks.jobnimbus.getRelatedJobs.mockResolvedValue([{ jnid: 'job' }]); // both have jobs

    const r = await resolveCanonicalContact(ctx, PHONE, { createStubIfMissing: true });

    expect(r.outcome).toBe('manual_review');
    expect(mocks.jobnimbus.archiveContact).not.toHaveBeenCalled();
  });
});
