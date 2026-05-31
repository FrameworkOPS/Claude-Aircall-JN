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
   * Download a call recording. The recording URL lives on a different host than
   * the API base, so this is a direct authenticated GET with light retries.
   */
  async downloadRecording(url: string): Promise<{ buffer: Buffer; contentType: string }> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await request(url, {
          method: 'GET',
          headers: { authorization: this.authHeader },
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
