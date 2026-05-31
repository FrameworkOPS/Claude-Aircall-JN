import { WebClient } from '@slack/web-api';
import type { Logger } from 'pino';
import type { Config } from '../config';

/**
 * Thin Slack wrapper for the estimate-signed sales shoutout. Destination is
 * fully env-driven (SLACK_BOT_TOKEN + SLACK_CHANNEL_ID) so it posts to whichever
 * workspace/channel is configured at deploy time.
 */
export class SlackClient {
  private readonly client: WebClient | null;
  private readonly channel: string;

  constructor(
    config: Config,
    private readonly logger: Logger,
  ) {
    this.channel = config.SLACK_CHANNEL_ID;
    this.client = config.SLACK_BOT_TOKEN ? new WebClient(config.SLACK_BOT_TOKEN) : null;
  }

  get enabled(): boolean {
    return this.client !== null && this.channel !== '';
  }

  async postShoutout(args: {
    repName: string;
    customerName: string;
    amount: number | null;
    estimateLink?: string;
  }): Promise<{ ts: string | null }> {
    if (!this.client) {
      this.logger.warn('Slack not configured; skipping shoutout');
      return { ts: null };
    }
    const amount =
      args.amount != null
        ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(args.amount)
        : 'an unspecified amount';
    const text = `:tada: *Estimate signed!* ${args.repName} just closed *${args.customerName}* for *${amount}*. :moneybag:`;

    const res = await this.client.chat.postMessage({
      channel: this.channel,
      text,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text },
        },
        ...(args.estimateLink
          ? [
              {
                type: 'context' as const,
                elements: [{ type: 'mrkdwn' as const, text: `<${args.estimateLink}|View estimate>` }],
              },
            ]
          : []),
      ],
    });
    return { ts: typeof res.ts === 'string' ? res.ts : null };
  }
}
