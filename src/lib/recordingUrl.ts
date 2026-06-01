import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC-signed, expiring URLs for the self-hosted recording playback endpoint.
 *
 * URL shape: <base>/recordings/<call_id>?exp=<unix_ms>&sig=<hex>
 *   sig = HMAC-SHA256(secret, `${call_id}.${exp}`)
 *
 * Anyone with the link can play the recording until `exp`. Links can't be
 * guessed or fabricated without the secret, and they stop working after the
 * configured TTL — which limits the blast radius of a leaked URL.
 */

export function signRecordingUrl(opts: {
  baseUrl: string;
  callId: string | number;
  ttlMs: number;
  secret: string;
  now?: number;
}): string {
  const exp = (opts.now ?? Date.now()) + opts.ttlMs;
  const id = String(opts.callId);
  const sig = createHmac('sha256', opts.secret).update(`${id}.${exp}`).digest('hex');
  const base = opts.baseUrl.replace(/\/+$/, '');
  return `${base}/recordings/${encodeURIComponent(id)}?exp=${exp}&sig=${sig}`;
}

export function verifyRecordingSig(opts: {
  callId: string;
  exp: number;
  sig: string;
  secret: string;
  now?: number;
}): boolean {
  if (!opts.exp || !Number.isFinite(opts.exp)) return false;
  if (opts.exp < (opts.now ?? Date.now())) return false;
  if (!/^[a-f0-9]+$/i.test(opts.sig)) return false;
  const expected = createHmac('sha256', opts.secret)
    .update(`${opts.callId}.${opts.exp}`)
    .digest('hex');
  const a = Buffer.from(opts.sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Resolve the public origin for building signed URLs (falls back to Railway's domain). */
export function publicBaseUrl(config: { PUBLIC_BASE_URL?: string }, env: NodeJS.ProcessEnv = process.env): string {
  if (config.PUBLIC_BASE_URL) return config.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const domain = env.RAILWAY_PUBLIC_DOMAIN;
  if (domain) return `https://${domain}`;
  throw new Error('PUBLIC_BASE_URL is not set and RAILWAY_PUBLIC_DOMAIN is not present');
}
