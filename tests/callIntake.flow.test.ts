import { processCallIntake } from '../src/flows/callIntake';
import { buildTestCtx } from './support';

describe('processCallIntake (Flow A) — Insight Card push', () => {
  it('pushes an insight card with the JobNimbus customer name + related job link', async () => {
    const { ctx, mocks } = buildTestCtx();
    mocks.jobnimbus.findContactsByPhone.mockResolvedValue([
      { jnid: 'c1', first_name: 'Adam', last_name: 'West', display_name: 'Adam West' },
    ]);
    mocks.jobnimbus.getRelatedJobs.mockResolvedValue([
      { jnid: 'job_42', name: 'West Residence - 1685' },
    ]);

    await processCallIntake(ctx, { call_id: 12345, phone: '+1 763-232-2305', direction: 'inbound' });

    expect(mocks.aircall.pushInsightCard).toHaveBeenCalledTimes(1);
    const [callId, contents] = mocks.aircall.pushInsightCard.mock.calls[0];
    expect(callId).toBe(12345);
    expect(contents[0]).toMatchObject({ type: 'title', text: 'Adam West' });
    expect(contents[0].link).toContain('/contact/c1');
    expect(contents[1]).toMatchObject({
      type: 'shortText',
      label: 'Job',
      text: 'West Residence - 1685',
    });
    expect(contents[1].link).toContain('/job/job_42');
  });

  it('pushes a "New caller · <phone>" card when only a stub exists (no real name in JN)', async () => {
    const { ctx, mocks } = buildTestCtx();
    mocks.jobnimbus.findContactsByPhone.mockResolvedValue([]); // no match -> create stub
    mocks.jobnimbus.createContact.mockResolvedValue({
      jnid: 'stub_1',
      first_name: 'Aircall',
      last_name: '+12085551234',
    });
    mocks.jobnimbus.getRelatedJobs.mockResolvedValue([]);

    await processCallIntake(ctx, { call_id: 999, phone: '+12085551234', direction: 'inbound' });

    expect(mocks.aircall.pushInsightCard).toHaveBeenCalledTimes(1);
    const [callId, contents] = mocks.aircall.pushInsightCard.mock.calls[0];
    expect(callId).toBe(999);
    expect(contents[0].type).toBe('title');
    expect(String(contents[0].text)).toMatch(/New caller/);
    // Stub note appended
    const statusLine = contents.find((c: { label?: string }) => c.label === 'Status');
    expect(statusLine).toBeDefined();
  });

  it('skips the card push when the phone is unparseable', async () => {
    const { ctx, mocks } = buildTestCtx();
    await processCallIntake(ctx, { call_id: 5, phone: 'gibberish', direction: 'inbound' });
    expect(mocks.aircall.pushInsightCard).not.toHaveBeenCalled();
  });
});
