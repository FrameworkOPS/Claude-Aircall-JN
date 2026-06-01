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

/**
 * JobNimbus webhook for "job created" -> push name back to Aircall (Flow B).
 * The automation payload shape is configurable in JobNimbus, so accept anything
 * and extract the related contact jnid (or inline name/phone) defensively.
 */
export const JobNimbusJobWebhookSchema = z.record(z.unknown());
export type JobNimbusJobWebhook = z.infer<typeof JobNimbusJobWebhookSchema>;

/** Pull the related contact jnid (and any inline name/phone) from a job payload. */
export function extractJobContact(body: JobNimbusJobWebhook): {
  contactJnid: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
} {
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
  const e = ((body as { data?: unknown }).data ?? body) as Record<string, unknown>;

  let contactJnid = str(e.contact_jnid) ?? str(e.contact_id) ?? str(e.primary_contact_id);

  const related =
    (Array.isArray(e.related) && (e.related as Array<Record<string, unknown>>)) ||
    (Array.isArray((body as { related?: unknown }).related) &&
      ((body as { related: unknown }).related as Array<Record<string, unknown>>)) ||
    [];
  if (!contactJnid && Array.isArray(related)) {
    const c = related.find((r) => String(r?.type ?? '').toLowerCase() === 'contact');
    contactJnid = c ? str(c.id) : null;
  }

  const primary = (e as { primary?: Record<string, unknown> }).primary;
  if (!contactJnid && primary && typeof primary === 'object') contactJnid = str(primary.id);

  return {
    contactJnid,
    phone: str(e.mobile_phone) ?? str(e.phone) ?? str(e.number) ?? str(e.raw_digits),
    firstName: str(e.first_name),
    lastName: str(e.last_name),
  };
}

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
