import type { AppContext } from '../context';

export interface EstimateShoutoutPayload {
  estimate_jnid: string;
  /** Status carried from the webhook; re-verified against the fetched estimate. */
  signed_status?: string;
}

/**
 * Estimate fully signed -> Slack sales shoutout.
 *
 * 1. Idempotency: skip if we already posted for this estimate.
 * 2. Fetch the authoritative estimate (amount, rep, related customer/job).
 * 3. Confirm it really is signed (config ESTIMATE_SIGNED_STATUSES).
 * 4. Post the shoutout; record processed_estimates.
 */
export async function postEstimateShoutout(
  ctx: AppContext,
  payload: EstimateShoutoutPayload,
): Promise<void> {
  const { logger, repo, jobnimbus, slack, config } = ctx;
  const jnid = payload.estimate_jnid;
  const log = logger.child({ flow: 'estimate_shoutout', estimate_jnid: jnid });

  if (await repo.getProcessedEstimate(jnid)) {
    log.info('estimate already announced; skipping');
    return;
  }

  const estimate = await jobnimbus.getEstimate(jnid);

  const status = String(estimate.status_name ?? payload.signed_status ?? '').toLowerCase();
  const isSigned =
    config.ESTIMATE_SIGNED_STATUSES.includes(status) || Boolean(estimate.date_signed);
  if (!isSigned) {
    log.info({ status }, 'estimate not in a signed state; skipping shoutout');
    return;
  }

  const repName = estimate.sales_rep_name || estimate.sales_rep || 'A team member';
  const related = estimate.related ?? [];
  const customer =
    related.find((r) => r.type === 'job')?.name ??
    related.find((r) => r.type === 'contact')?.name ??
    'a customer';
  const amount = typeof estimate.total === 'number' ? estimate.total : null;

  if (!slack.enabled) {
    log.warn('Slack not configured; recording estimate as processed without posting');
    await repo.recordProcessedEstimate({
      estimate_jnid: jnid,
      signed_amount: amount,
      slack_channel: config.SLACK_CHANNEL_ID,
      slack_ts: null,
    });
    return;
  }

  const { ts } = await slack.postShoutout({ repName, customerName: customer, amount });

  await repo.recordProcessedEstimate({
    estimate_jnid: jnid,
    signed_amount: amount,
    slack_channel: config.SLACK_CHANNEL_ID,
    slack_ts: ts,
  });

  log.info({ rep: repName, amount }, 'posted signed-estimate shoutout to Slack');
}
