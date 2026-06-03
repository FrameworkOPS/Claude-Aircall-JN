import { logSms } from '../src/flows/smsLog';
import { buildTestCtx } from './support';

describe('Flow D — Aircall SMS → JobNimbus activity', () => {
  it('inbound: posts the SMS as an activity on the customer’s most-recent job', async () => {
    const { ctx, mocks } = buildTestCtx();
    mocks.jobnimbus.findContactsByPhone.mockResolvedValue([
      { jnid: 'c_adam', first_name: 'Adam', last_name: 'West', display_name: 'Adam West' },
    ]);
    mocks.jobnimbus.getRelatedJobs.mockResolvedValue([
      { jnid: 'job_42', name: 'Roof Replacement' },
    ]);
    mocks.jobnimbus.createActivity.mockResolvedValue({ jnid: 'a_1' });

    await logSms(ctx, {
      sms_id: 'sms_1',
      direction: 'inbound',
      body: 'Hey, can we move the install to next week?',
      from: '+1 763-232-2305',
      to: '+12085551111',
      created_at: 1780500000,
    });

    expect(mocks.jobnimbus.createActivity).toHaveBeenCalledTimes(1);
    const args = mocks.jobnimbus.createActivity.mock.calls[0][0];
    expect(args.relatedId).toBe('job_42');
    expect(args.relatedType).toBe('job');
    expect(String(args.note)).toMatch(/Aircall SMS · inbound/);
    expect(String(args.note)).toContain('move the install to next week');
    expect(String(args.note)).toContain('+17632322305'); // normalized phone
  });

  it('outbound: uses the to-number, includes agent name', async () => {
    const { ctx, mocks } = buildTestCtx();
    mocks.jobnimbus.findContactsByPhone.mockResolvedValue([
      { jnid: 'c_paul', first_name: 'Paul', last_name: 'Satchwell' },
    ]);
    mocks.jobnimbus.getRelatedJobs.mockResolvedValue([]);
    mocks.jobnimbus.createActivity.mockResolvedValue({ jnid: 'a_2' });

    await logSms(ctx, {
      sms_id: 99,
      direction: 'outbound',
      body: 'Crew is on their way!',
      from: '+12089999999',
      to: '+1-208-920-1194',
      agent_name: 'Quincy Greene',
    });

    const args = mocks.jobnimbus.createActivity.mock.calls[0][0];
    expect(args.relatedId).toBe('c_paul'); // no related job -> contact fallback
    expect(args.relatedType).toBe('contact');
    expect(String(args.note)).toMatch(/Aircall SMS · outbound/);
    expect(String(args.note)).toContain('Agent: Quincy Greene');
    expect(String(args.note)).toContain('Crew is on their way!');
  });

  it('skips when the SMS has no parseable external phone', async () => {
    const { ctx, mocks } = buildTestCtx();
    await logSms(ctx, { sms_id: 'sms_x', direction: 'inbound', body: 'hi', from: '', to: '' });
    expect(mocks.jobnimbus.createActivity).not.toHaveBeenCalled();
  });
});
