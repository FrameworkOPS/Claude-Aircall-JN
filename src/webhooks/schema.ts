import { z } from 'zod';

/** Aircall webhook envelope. `data` shape varies by event; kept permissive. */
export const AircallWebhookSchema = z.object({
  resource: z.string(),
  event: z.string(),
  timestamp: z.union([z.number(), z.string()]).optional(),
  token: z.string().optional(),
  data: z.record(z.unknown()),
});
export type AircallWebhook = z.infer<typeof AircallWebhookSchema>;

/**
 * JobNimbus webhook for estimate signature. JobNimbus automation payloads are
 * not strictly documented; accept either a flat estimate or a `data`-wrapped
 * one and pull out the jnid + signature/status defensively.
 */
export const JobNimbusEstimateWebhookSchema = z
  .object({
    jnid: z.string().optional(),
    type: z.string().optional(),
    status_name: z.string().optional(),
    signature_status: z.string().optional(),
    date_signed: z.union([z.number(), z.string()]).optional(),
    data: z.record(z.unknown()).optional(),
  })
  .passthrough();
export type JobNimbusEstimateWebhook = z.infer<typeof JobNimbusEstimateWebhookSchema>;

/** Pull the estimate jnid + status from either a flat or wrapped payload. */
export function extractEstimate(body: JobNimbusEstimateWebhook): {
  jnid: string | null;
  status: string | null;
  signed: boolean;
} {
  const e = (body.data ?? body) as Record<string, unknown>;
  const jnid = typeof e.jnid === 'string' ? e.jnid : null;
  const status =
    (typeof e.signature_status === 'string' && e.signature_status) ||
    (typeof e.status_name === 'string' && e.status_name) ||
    null;
  const signed = Boolean(e.date_signed) || /sign|complete|approv/i.test(status ?? '');
  return { jnid, status, signed };
}
