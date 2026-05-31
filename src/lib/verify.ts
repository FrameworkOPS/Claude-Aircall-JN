import { createHmac, timingSafeEqual } from 'node:crypto';

/** Constant-time string comparison that won't throw on length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    // Still do a compare to keep timing roughly constant.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** HMAC-SHA1 hex of the raw body, keyed by `secret` (Aircall uses the API token). */
export function hmacSha1Hex(rawBody: string, secret: string): string {
  return createHmac('sha1', secret).update(rawBody).digest('hex');
}

/**
 * Verify an Aircall webhook. Always checks the body `token` against the
 * configured webhook secret. When `verifyHmac` is on, also verifies the
 * X-Aircall-Signature HMAC-SHA1 over the raw body keyed by the API token.
 */
export function verifyAircall(args: {
  rawBody: string;
  bodyToken: string | undefined;
  signatureHeader: string | undefined;
  webhookSecret: string;
  apiToken: string;
  verifyHmac: boolean;
}): { ok: boolean; reason?: string } {
  if (!args.bodyToken || !safeEqual(args.bodyToken, args.webhookSecret)) {
    return { ok: false, reason: 'token mismatch' };
  }
  if (args.verifyHmac) {
    if (!args.signatureHeader) return { ok: false, reason: 'missing signature header' };
    const expected = hmacSha1Hex(args.rawBody, args.apiToken);
    if (!safeEqual(args.signatureHeader.trim(), expected)) {
      return { ok: false, reason: 'signature mismatch' };
    }
  }
  return { ok: true };
}
