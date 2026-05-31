import { syncContact } from '../src/flows/contactSync';
import { postEstimateShoutout } from '../src/flows/estimateShoutout';
import { buildTestCtx } from './support';

describe('syncContact (Flow 1 dedup)', () => {
  const contact = {
    id: 555,
    first_name: 'Pat',
    last_name: 'Roof',
    phone_numbers: [{ label: 'Mobile', value: '(208) 555-1234' }],
  };

  it('creates a JobNimbus contact when none matches, and records the mapping', async () => {
    const { ctx, mocks } = buildTestCtx();
    mocks.jobnimbus.findContactsByPhone.mockResolvedValue([]);

    await syncContact(ctx, contact);

    expect(mocks.jobnimbus.createContact).toHaveBeenCalledWith(
      expect.objectContaining({ first_name: 'Pat', mobile_phone: '+12085551234' }),
    );
    expect(mocks.jobnimbus.updateContact).not.toHaveBeenCalled();
    expect(mocks.repo.upsertMapping).toHaveBeenCalledWith(
      expect.objectContaining({ jobnimbus_jnid: 'new_contact', normalized_phone: '+12085551234' }),
    );
  });

  it('updates the existing contact when exactly one matches', async () => {
    const { ctx, mocks } = buildTestCtx();
    mocks.jobnimbus.findContactsByPhone.mockResolvedValue([{ jnid: 'existing' }]);

    await syncContact(ctx, contact);

    expect(mocks.jobnimbus.updateContact).toHaveBeenCalledWith('existing', expect.any(Object));
    expect(mocks.jobnimbus.createContact).not.toHaveBeenCalled();
  });

  it('flags DUPLICATE_CONFLICT and writes nothing when multiple match', async () => {
    const { ctx, mocks } = buildTestCtx();
    mocks.jobnimbus.findContactsByPhone.mockResolvedValue([{ jnid: 'a' }, { jnid: 'b' }]);

    await syncContact(ctx, contact);

    expect(mocks.jobnimbus.createContact).not.toHaveBeenCalled();
    expect(mocks.jobnimbus.updateContact).not.toHaveBeenCalled();
    expect(mocks.repo.upsertMapping).not.toHaveBeenCalled();
  });

  it('skips contacts with no valid phone number', async () => {
    const { ctx, mocks } = buildTestCtx();
    await syncContact(ctx, { id: 1, phone_numbers: [{ value: 'not-a-number' }] });
    expect(mocks.jobnimbus.findContactsByPhone).not.toHaveBeenCalled();
    expect(mocks.jobnimbus.createContact).not.toHaveBeenCalled();
  });
});

describe('postEstimateShoutout', () => {
  it('posts a Slack shoutout with rep, customer, and amount for a signed estimate', async () => {
    const { ctx, mocks } = buildTestCtx();
    mocks.jobnimbus.getEstimate.mockResolvedValue({
      jnid: 'est_1',
      total: 14500,
      status_name: 'Signed',
      sales_rep_name: 'Sam Sales',
      related: [{ id: 'job_1', type: 'job', name: 'Smith Reroof' }],
    });

    await postEstimateShoutout(ctx, { estimate_jnid: 'est_1' });

    expect(mocks.slack.postShoutout).toHaveBeenCalledWith(
      expect.objectContaining({ repName: 'Sam Sales', customerName: 'Smith Reroof', amount: 14500 }),
    );
    expect(mocks.repo.recordProcessedEstimate).toHaveBeenCalledWith(
      expect.objectContaining({ estimate_jnid: 'est_1', signed_amount: 14500 }),
    );
  });

  it('is idempotent: skips an estimate already announced', async () => {
    const { ctx, mocks } = buildTestCtx();
    mocks.repo.getProcessedEstimate.mockResolvedValue({ estimate_jnid: 'est_1' });

    await postEstimateShoutout(ctx, { estimate_jnid: 'est_1' });

    expect(mocks.jobnimbus.getEstimate).not.toHaveBeenCalled();
    expect(mocks.slack.postShoutout).not.toHaveBeenCalled();
  });

  it('skips when the estimate is not actually signed', async () => {
    const { ctx, mocks } = buildTestCtx();
    mocks.jobnimbus.getEstimate.mockResolvedValue({ jnid: 'est_1', total: 100, status_name: 'sent' });

    await postEstimateShoutout(ctx, { estimate_jnid: 'est_1' });

    expect(mocks.slack.postShoutout).not.toHaveBeenCalled();
  });
});
