import { signRecordingUrl, verifyRecordingSig } from '../src/lib/recordingUrl';

const SECRET = 'unit-test-recording-url-secret-min-32-chars';

describe('recording URL signing', () => {
  it('signs a URL that verifies with the same secret', () => {
    const now = 1_700_000_000_000;
    const url = signRecordingUrl({
      baseUrl: 'https://example.test',
      callId: 12345,
      ttlMs: 60_000,
      secret: SECRET,
      now,
    });
    const u = new URL(url);
    expect(u.pathname).toBe('/recordings/12345');
    const ok = verifyRecordingSig({
      callId: '12345',
      exp: Number(u.searchParams.get('exp')),
      sig: u.searchParams.get('sig')!,
      secret: SECRET,
      now,
    });
    expect(ok).toBe(true);
  });

  it('rejects an expired URL', () => {
    const now = 1_700_000_000_000;
    const url = signRecordingUrl({
      baseUrl: 'https://example.test',
      callId: 'abc',
      ttlMs: 1_000,
      secret: SECRET,
      now,
    });
    const u = new URL(url);
    const ok = verifyRecordingSig({
      callId: 'abc',
      exp: Number(u.searchParams.get('exp')),
      sig: u.searchParams.get('sig')!,
      secret: SECRET,
      now: now + 60_000, // well past TTL
    });
    expect(ok).toBe(false);
  });

  it('rejects a tampered call id', () => {
    const now = 1_700_000_000_000;
    const url = signRecordingUrl({
      baseUrl: 'https://example.test',
      callId: 'real',
      ttlMs: 60_000,
      secret: SECRET,
      now,
    });
    const u = new URL(url);
    const ok = verifyRecordingSig({
      callId: 'forged',
      exp: Number(u.searchParams.get('exp')),
      sig: u.searchParams.get('sig')!,
      secret: SECRET,
      now,
    });
    expect(ok).toBe(false);
  });

  it('rejects a different secret', () => {
    const now = 1_700_000_000_000;
    const url = signRecordingUrl({ baseUrl: 'https://x', callId: 'c', ttlMs: 60_000, secret: SECRET, now });
    const u = new URL(url);
    expect(
      verifyRecordingSig({
        callId: 'c',
        exp: Number(u.searchParams.get('exp')),
        sig: u.searchParams.get('sig')!,
        secret: 'WRONG-' + SECRET,
        now,
      }),
    ).toBe(false);
  });
});
