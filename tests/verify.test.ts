import { verifyAircall, hmacSha1Hex, safeEqual } from '../src/lib/verify';

describe('verifyAircall', () => {
  const body = JSON.stringify({ event: 'call.ended', token: 'wh_secret', data: { id: 1 } });

  it('accepts a matching body token (HMAC off)', () => {
    const r = verifyAircall({
      rawBody: body,
      bodyToken: 'wh_secret',
      signatureHeader: undefined,
      webhookSecret: 'wh_secret',
      apiToken: 'api_tok',
      verifyHmac: false,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects a wrong/missing token', () => {
    expect(verifyAircall({ rawBody: body, bodyToken: 'nope', signatureHeader: undefined, webhookSecret: 'wh_secret', apiToken: 'x', verifyHmac: false }).ok).toBe(false);
    expect(verifyAircall({ rawBody: body, bodyToken: undefined, signatureHeader: undefined, webhookSecret: 'wh_secret', apiToken: 'x', verifyHmac: false }).ok).toBe(false);
  });

  it('verifies HMAC-SHA1 over the raw body when enabled', () => {
    const sig = hmacSha1Hex(body, 'api_tok');
    expect(
      verifyAircall({ rawBody: body, bodyToken: 'wh_secret', signatureHeader: sig, webhookSecret: 'wh_secret', apiToken: 'api_tok', verifyHmac: true }).ok,
    ).toBe(true);
    expect(
      verifyAircall({ rawBody: body, bodyToken: 'wh_secret', signatureHeader: 'deadbeef', webhookSecret: 'wh_secret', apiToken: 'api_tok', verifyHmac: true }).ok,
    ).toBe(false);
  });
});

describe('safeEqual', () => {
  it('compares constant-time without throwing on length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});
