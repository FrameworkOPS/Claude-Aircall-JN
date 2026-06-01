import type { Logger } from 'pino';
import type { Config } from '../config';
import { HttpClient } from '../lib/httpClient';
import { normalizePhone } from '../lib/phone';

/** Phone fields we read/compare on a JobNimbus contact. */
export const JN_PHONE_FIELDS = ['mobile_phone', 'home_phone', 'work_phone'] as const;

export interface JnContact {
  jnid: string;
  display_name?: string;
  first_name?: string;
  last_name?: string;
  mobile_phone?: string;
  home_phone?: string;
  work_phone?: string;
  [k: string]: unknown;
}

export interface JnJob {
  jnid: string;
  name?: string;
  display_name?: string;
  [k: string]: unknown;
}

export interface JnEstimate {
  jnid: string;
  total?: number;
  status_name?: string;
  signature_status?: string;
  esigned?: boolean;
  date_signed?: number;
  sales_rep_name?: string;
  sales_rep?: string;
  related?: Array<{ id: string; type: string; name?: string }>;
  [k: string]: unknown;
}

/**
 * JobNimbus Public API client. Methods are GET/POST/PUT only (the API supports
 * nothing else). Phone search is best-effort server-side then re-verified
 * client-side on normalized E.164 — see buildPhoneFilter notes.
 */
export class JobNimbusClient {
  private readonly http: HttpClient;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.http = new HttpClient({
      name: 'jobnimbus',
      baseUrl: config.JOBNIMBUS_BASE_URL,
      defaultHeaders: {
        authorization: `Bearer ${config.JOBNIMBUS_API_KEY}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      rateLimitPerMin: config.JOBNIMBUS_RATE_LIMIT_PER_MIN,
      maxRetries: config.MAX_RETRIES,
      logger,
    });
  }

  /**
   * RISK: the exact JobNimbus `filter` JSON for an exact phone match is not
   * fully documented. This is intentionally the ONLY place that knows the query
   * shape. Whatever the server returns, callers re-verify client-side, so a
   * too-broad/too-narrow filter can never cause a wrong write.
   */
  private buildPhoneFilter(e164: string): string {
    const digits = e164.replace(/\D/g, '');
    const national = digits.length > 10 ? digits.slice(-10) : digits;
    const should = JN_PHONE_FIELDS.flatMap((f) => [
      { term: { [f]: e164 } },
      { match_phrase: { [f]: national } },
    ]);
    return JSON.stringify({ must: [{ bool: { should, minimum_should_match: 1 } }] });
  }

  private extractRecords<T>(res: unknown): T[] {
    if (Array.isArray(res)) return res as T[];
    const r = res as { results?: T[]; data?: T[] } | null;
    return r?.results ?? r?.data ?? [];
  }

  /**
   * Search contacts by phone, then re-verify every candidate by normalizing all
   * of its phone fields and exact-comparing E.164. Returns only true matches.
   */
  async findContactsByPhone(e164: string): Promise<JnContact[]> {
    const res = await this.http.json<unknown>({
      path: '/contacts',
      query: { filter: this.buildPhoneFilter(e164), size: 50 },
    });
    const candidates = this.extractRecords<JnContact>(res);
    return candidates.filter((c) => this.contactHasPhone(c, e164));
  }

  private contactHasPhone(c: JnContact, e164: string): boolean {
    return JN_PHONE_FIELDS.some((f) => {
      const v = c[f];
      return normalizePhone(typeof v === 'string' ? v : null, this.config.DEFAULT_PHONE_REGION) === e164;
    });
  }

  async getContact(jnid: string): Promise<JnContact> {
    return this.http.json<JnContact>({ path: `/contacts/${jnid}` });
  }

  async createContact(body: Partial<JnContact>): Promise<JnContact> {
    return this.http.json<JnContact>({ method: 'POST', path: '/contacts', json: body });
  }

  async updateContact(jnid: string, body: Partial<JnContact>): Promise<JnContact> {
    return this.http.json<JnContact>({ method: 'PUT', path: `/contacts/${jnid}`, json: body });
  }

  /**
   * Soft-delete a contact (JobNimbus has no hard delete via the public API).
   * Used by the dedup/merge step to retire empty duplicate stubs.
   */
  async archiveContact(jnid: string): Promise<JnContact> {
    return this.updateContact(jnid, {
      is_active: false,
      is_archived: true,
    } as Partial<JnContact>);
  }

  /** Jobs related to a contact (the contact's jnid appears in related.id). */
  async getRelatedJobs(contactJnid: string): Promise<JnJob[]> {
    const filter = JSON.stringify({
      must: [{ nested: { path: 'related', query: { term: { 'related.id': contactJnid } } } }],
    });
    try {
      const res = await this.http.json<unknown>({ path: '/jobs', query: { filter, size: 50 } });
      return this.extractRecords<JnJob>(res);
    } catch (err) {
      this.logger.warn({ err: String(err), contactJnid }, 'related jobs lookup failed');
      return [];
    }
  }

  /**
   * Create an activity/note linked to a contact or job. Association is set via
   * `primary` (an object). NOTE: JobNimbus rejects a `related` ARRAY on write
   * ("Attempt to relate to invalid document") and derives `related` from
   * `primary` itself.
   */
  async createActivity(args: {
    relatedId: string;
    relatedType: 'contact' | 'job';
    note: string;
    recordTypeName?: string;
  }): Promise<{ jnid: string }> {
    const res = await this.http.json<{ jnid: string }>({
      method: 'POST',
      path: '/activities',
      json: {
        note: args.note,
        record_type_name: args.recordTypeName ?? 'Note',
        primary: { id: args.relatedId, type: args.relatedType },
      },
    });
    return { jnid: res.jnid };
  }

  /**
   * Upload a file (e.g. call recording) attached to a contact or job.
   *
   * JobNimbus is JSON-only: the file is sent base64-encoded in `data` (NOT
   * multipart), and the association is set via `primary` (an object). A
   * `related` array is rejected with "Attempt to relate to invalid document".
   */
  async uploadFile(args: {
    relatedId: string;
    relatedType: 'contact' | 'job';
    filename: string;
    buffer: Buffer;
    contentType: string;
    description?: string;
  }): Promise<{ jnid: string }> {
    const res = await this.http.json<{ jnid: string }>({
      method: 'POST',
      path: '/files',
      json: {
        filename: args.filename,
        content_type: args.contentType,
        data: args.buffer.toString('base64'),
        description: args.description,
        primary: { id: args.relatedId, type: args.relatedType },
      },
    });
    return { jnid: res?.jnid ?? '' };
  }

  /**
   * Fetch one estimate. JobNimbus does NOT serve estimates at /estimates/:jnid
   * (404) — they're only retrievable via the filtered list query.
   */
  async getEstimate(jnid: string): Promise<JnEstimate> {
    const filter = JSON.stringify({ must: [{ term: { jnid } }] });
    const res = await this.http.json<unknown>({ path: '/estimates', query: { filter, size: 1 } });
    const records = this.extractRecords<JnEstimate>(res);
    const estimate = records[0];
    if (!estimate) throw new Error(`estimate ${jnid} not found`);
    return estimate;
  }
}
