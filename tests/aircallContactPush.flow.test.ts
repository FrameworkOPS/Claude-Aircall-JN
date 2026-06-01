import { pushAircallContact } from '../src/flows/aircallContactPush';
import { buildTestCtx } from './support';

const PHONE = '+12085551234';

describe('pushAircallContact (Flow B: JobNimbus job -> Aircall)', () => {
  it('skips when the JobNimbus contact is still an unfilled Aircall stub', async () => {
    const { ctx, mocks } = buildTestCtx();
    mocks.jobnimbus.getContact.mockResolvedValue({
      jnid: 'c',
      first_name: 'Aircall',
      last_name: PHONE,
      mobile_phone: PHONE,
    });

    await pushAircallContact(ctx, { jobnimbus_contact_jnid: 'c' });

    expect(mocks.aircall.createContact).not.toHaveBeenCalled();
    expect(mocks.aircall.updateContact).not.toHaveBeenCalled();
  });

  it('creates an Aircall contact when none is mapped or found, and records the mapping', async () => {
    const { ctx, mocks } = buildTestCtx();
    mocks.jobnimbus.getContact.mockResolvedValue({
      jnid: 'c',
      first_name: 'Jane',
      last_name: 'Doe',
      mobile_phone: PHONE,
    });
    mocks.repo.getMappingByPhone.mockResolvedValue([]);
    mocks.aircall.searchContactByPhone.mockResolvedValue([]);
    mocks.aircall.createContact.mockResolvedValue({ id: 999 });

    await pushAircallContact(ctx, { jobnimbus_contact_jnid: 'c' });

    expect(mocks.aircall.createContact).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'Jane', lastName: 'Doe', phone: PHONE }),
    );
    expect(mocks.repo.upsertMapping).toHaveBeenCalledWith(
      expect.objectContaining({ aircall_contact_id: '999', jobnimbus_jnid: 'c', normalized_phone: PHONE }),
    );
  });

  it('updates the known Aircall contact when a phone mapping exists (no duplicate)', async () => {
    const { ctx, mocks } = buildTestCtx();
    mocks.jobnimbus.getContact.mockResolvedValue({
      jnid: 'c',
      first_name: 'Jane',
      last_name: 'Doe',
      mobile_phone: PHONE,
    });
    mocks.repo.getMappingByPhone.mockResolvedValue([
      { aircall_contact_id: '555', jobnimbus_jnid: 'c', normalized_phone: PHONE },
    ]);
    mocks.aircall.updateContact.mockResolvedValue({ id: 555 });

    await pushAircallContact(ctx, { jobnimbus_contact_jnid: 'c' });

    expect(mocks.aircall.updateContact).toHaveBeenCalledWith(
      '555',
      expect.objectContaining({ firstName: 'Jane', lastName: 'Doe' }),
    );
    expect(mocks.aircall.createContact).not.toHaveBeenCalled();
  });
});
