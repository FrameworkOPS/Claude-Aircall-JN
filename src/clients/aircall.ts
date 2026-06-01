import { request } from 'undici';
import type { Logger } from 'pino';
import type { Config } from '../config';
import { HttpClient, HttpError } from '../lib/httpClient';

export interface AircallCall {
  id: number;
  direction: 'inbound' | 'outbound';
  raw_digits: string;
  started_at: number | null;
  answered_at: number | null;
  ended_at: number | null;
  duration: number | null;
  recording: string | null;
  user?: { id: number; name: string; email?: string } | null;
  number?: { id: number; digits?: string; name?: string } | null;
}

export interface AircallContact {
  id: number;
  first_name?: string | null;
  last_name?: string | null;
  phone_numbers?: Array<{ id?: number; label?: string; value: string }>;
}

/** Client for the Aircall REST API (Basic Auth). */
export class AircallClient {
  private readonly http: HttpClient;
  private readonly authHeader: string;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.authHeader =
      'Basic ' +
      Buffer.from(`${config.AIRCALL_API_ID}:${config.AIRCALL_API_TOKEN}`).toString('base64');
    this.http = new HttpClient({
      name: 'aircall',
      baseUrl: config.AIRCALL_BASE_URL,
      defaultHeaders: { authorization: this.authHeader, accept: 'application/json' },
      rateLimitPerMin: config.AIRCALL_RATE_LIMIT_PER_MIN,
      maxRetries: config.MAX_RETRIES,
      logger,
    });
  }

  /** GET /calls/:id — authoritative call metadata + recording URL. */
  async getCall(callId: number | string): Promise<AircallCall> {
    const res = await this.http.json<{ call: AircallCall }>({ path: `/calls/${callId}` });
    return res.call;
  }

  /**
   * Search shared Aircall contacts by phone number. NOTE: Aircall's contact
   * search index is eventually-consistent (a just-created contact may not show
   * for a while), so callers should not rely on this alone for dedup — we also
   * persist a phone→contact-id map. Best-effort: returns [] on error.
   */
  async searchContactByPhone(e164: string): Promise<AircallContact[]> {
    try {
      const res = await this.http.json<{ contacts?: AircallContact[] }>({
        path: '/contacts/search',
        query: { phone_number: e164 },
      });
      return res.contacts ?? [];
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'aircall contact search failed');
      return [];
    }
  }

  /** POST /contacts — create a shared contact with a single phone number. */
  async createContact(args: {
    firstName: string;
    lastName: string;
    phone: string;
    phoneLabel?: string;
  }): Promise<AircallContact> {
    const res = await this.http.json<{ contact: AircallContact }>({
      method: 'POST',
      path: '/contacts',
      json: {
        first_name: args.firstName,
        last_name: args.lastName,
        phone_numbers: [{ label: args.phoneLabel ?? 'Other', value: args.phone }],
      },
    });
    return res.contact;
  }

  /** POST /contacts/:id — update a contact's name (Aircall uses POST to update). */
  async updateContact(
    id: number | string,
    args: { firstName?: string; lastName?: string },
  ): Promise<AircallContact> {
    const body: Record<string, unknown> = {};
    if (args.firstName !== undefined) body.first_name = args.firstName;
    if (args.lastName !== undefined) body.last_name = args.lastName;
    const res = await this.http.json<{ contact: AircallContact }>({
      method: 'POST',
      path: `/contacts/${id}`,
      json: body,
    });
    return res.contact;
  }

  /**
   * Stream a call recording (for proxying through our playback endpoint). Same
   * pre-signed-S3 caveat as downloadRecording: do NOT send the Aircall auth
   * header to non-aircall.io hosts.
   */
  async streamRecording(url: string): Promise<{
    statusCode: number;
    contentType: string;
    contentLength: string | undefined;
    body: NodeJS.ReadableStream;
  }> {
    let isAircallHost = false;
    try {
      isAircallHost = /(^|\.)aircall\.io$/i.test(new URL(url).hostname);
    } catch {
      isAircallHost = false;
    }
    const headers = isAircallHost ? { authorization: this.authHeader } : {};
    const res = await request(url, { method: 'GET', headers, maxRedirections: 3 });
    return {
      statusCode: res.statusCode,
      contentType: String(res.headers['content-type'] ?? 'audio/mpeg'),
      contentLength:
        typeof res.headers['content-length'] === 'string'
          ? (res.headers['content-length'] as string)
          : undefined,
      body: res.body as unknown as NodeJS.ReadableStream,
    };
  }

  /**
   * Download a call recording. Aircall returns a PRE-SIGNED S3 URL whose auth is
   * in the query string — sending our Basic auth header makes S3 reject it
   * ("Only one auth mechanism allowed"). So only attach the Authorization header
   * for actual Aircall API hosts; pre-signed/CDN hosts get no auth header.
   */
  async downloadRecording(url: string): Promise<{ buffer: Buffer; contentType: string }> {
    let isAircallHost = false;
    try {
      isAircallHost = /(^|\.)aircall\.io$/i.test(new URL(url).hostname);
    } catch {
      isAircallHost = false;
    }
    const headers = isAircallHost ? { authorization: this.authHeader } : {};

    let lastErr: unknown;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await request(url, {
          method: 'GET',
          headers,
          maxRedirections: 3,
        });
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const ab = await res.body.arrayBuffer();
          return {
            buffer: Buffer.from(ab),
            contentType: String(res.headers['content-type'] ?? 'audio/mpeg'),
          };
        }
        const text = await res.body.text();
        if (res.statusCode < 500 && res.statusCode !== 429) {
          throw new HttpError(res.statusCode, url, text);
        }
        lastErr = new HttpError(res.statusCode, url, text);
      } catch (err) {
        lastErr = err;
        if (err instanceof HttpError && err.status < 500 && err.status !== 429) throw err;
      }
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
