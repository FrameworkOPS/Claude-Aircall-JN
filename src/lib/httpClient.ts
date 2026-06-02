import { request } from 'undici';
import type { Logger } from 'pino';
import { RateLimiter } from './rateLimiter';

/** Thrown for non-2xx responses after retries are exhausted. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 500)}`);
    this.name = 'HttpError';
  }

  /** 404s are meaningful (e.g. transcript not ready yet) and often not errors. */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export interface HttpClientOptions {
  baseUrl: string;
  defaultHeaders?: Record<string, string>;
  rateLimitPerMin: number;
  maxRetries: number;
  logger: Logger;
  name: string;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  body?: Buffer | string;
  headers?: Record<string, string>;
  /** Skip JSON parsing and return the raw bytes (e.g. recording downloads). */
  raw?: boolean;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Rate-limited HTTP client with exponential backoff + jitter on 429/5xx, and
 * Retry-After support. All outbound calls to a given upstream go through one
 * instance so the rate limit is actually enforced process-wide.
 */
export class HttpClient {
  private readonly limiter: RateLimiter;

  constructor(private readonly opts: HttpClientOptions) {
    this.limiter = new RateLimiter(opts.rateLimitPerMin);
  }

  async json<T = unknown>(req: RequestOptions): Promise<T> {
    const res = await this.send(req);
    if (req.raw) return res as unknown as T;
    return res as T;
  }

  /** Returns raw bytes; used for recording downloads. */
  async bytes(req: RequestOptions): Promise<{ buffer: Buffer; contentType: string }> {
    return this.send({ ...req, raw: true }) as Promise<{
      buffer: Buffer;
      contentType: string;
    }>;
  }

  /**
   * Multipart/form-data upload (e.g. recording -> JobNimbus file). Uses the
   * global fetch so the boundary is set automatically; still goes through the
   * shared rate limiter and retry/backoff so uploads respect the API budget.
   */
  async uploadForm<T = unknown>(args: {
    path: string;
    form: FormData;
    query?: RequestOptions['query'];
  }): Promise<T> {
    const url = this.buildUrl(args.path, args.query);
    // Never send a JSON content-type with a multipart body; fetch sets it.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.opts.defaultHeaders ?? {})) {
      if (k.toLowerCase() !== 'content-type') headers[k] = v;
    }

    const maxAttempts = this.opts.maxRetries + 1;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.limiter.acquire();
      try {
        const res = await fetch(url, { method: 'POST', headers, body: args.form });
        const text = await res.text();
        if (res.ok) return (text ? JSON.parse(text) : undefined) as T;
        if (RETRYABLE_STATUS.has(res.status) && attempt < maxAttempts) {
          const delay = this.backoffMs(attempt, res.headers.get('retry-after') ?? undefined);
          this.opts.logger.warn(
            { upstream: this.opts.name, url, status: res.status, attempt, delay },
            'retryable upload error; backing off',
          );
          await sleep(delay);
          continue;
        }
        throw new HttpError(res.status, url, text);
      } catch (err) {
        lastErr = err;
        if (err instanceof HttpError) throw err;
        if (attempt < maxAttempts) {
          await sleep(this.backoffMs(attempt));
          continue;
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const base = this.opts.baseUrl.replace(/\/$/, '');
    const p = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(base + p);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private async send(req: RequestOptions): Promise<unknown> {
    const url = this.buildUrl(req.path, req.query);
    const method = req.method ?? 'GET';
    const headers: Record<string, string> = {
      ...(this.opts.defaultHeaders ?? {}),
      ...(req.headers ?? {}),
    };

    let body: string | Buffer | undefined;
    if (req.json !== undefined) {
      body = JSON.stringify(req.json);
      headers['content-type'] = headers['content-type'] ?? 'application/json';
    } else if (req.body !== undefined) {
      body = req.body;
    }

    const maxAttempts = this.opts.maxRetries + 1;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.limiter.acquire();
      try {
        const res = await request(url, { method, headers, body });
        const status = res.statusCode;

        if (status >= 200 && status < 300) {
          if (req.raw) {
            const ab = await res.body.arrayBuffer();
            return {
              buffer: Buffer.from(ab),
              contentType: String(res.headers['content-type'] ?? 'application/octet-stream'),
            };
          }
          const text = await res.body.text();
          return text ? JSON.parse(text) : undefined;
        }

        const text = await res.body.text();
        if (RETRYABLE_STATUS.has(status) && attempt < maxAttempts) {
          const delay = this.backoffMs(attempt, res.headers['retry-after']);
          this.opts.logger.warn(
            { upstream: this.opts.name, url, status, attempt, delay },
            'retryable upstream error; backing off',
          );
          await sleep(delay);
          continue;
        }
        throw new HttpError(status, url, text);
      } catch (err) {
        lastErr = err;
        // HttpError for a non-retryable status should propagate immediately.
        if (err instanceof HttpError) throw err;
        // Network-level error: retry with backoff.
        if (attempt < maxAttempts) {
          const delay = this.backoffMs(attempt);
          this.opts.logger.warn(
            { upstream: this.opts.name, url, attempt, delay, err: String(err) },
            'network error; backing off',
          );
          await sleep(delay);
          continue;
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private backoffMs(attempt: number, retryAfter?: string | string[]): number {
    if (retryAfter) {
      const raw = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter;
      const secs = Number(raw);
      if (Number.isFinite(secs) && secs > 0) return secs * 1000;
    }
    const base = Math.min(30_000, 500 * 2 ** (attempt - 1));
    const jitter = Math.random() * base * 0.25;
    return Math.floor(base + jitter);
  }
}
