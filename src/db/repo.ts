import type { Pool } from 'pg';

export type JobType = 'contact_sync' | 'recording' | 'estimate_shoutout';

export interface Job {
  id: string;
  type: JobType;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  max_attempts: number;
  run_after: Date;
  last_error: string | null;
  dedupe_key: string | null;
}

export interface ContactMapping {
  aircall_contact_id: string;
  jobnimbus_jnid: string;
  normalized_phone: string;
}

export interface ProcessedCall {
  aircall_call_id: string;
  jobnimbus_jnid: string | null;
  jobnimbus_activity_id: string | null;
  jobnimbus_file_id: string | null;
  recording_uploaded_at: Date | null;
  outcome: string | null;
}

/** All SQL lives here. Flows/worker depend on this interface, not on `pg`. */
export class Repo {
  constructor(private readonly pool: Pool) {}

  async saveWebhookEvent(
    source: string,
    eventType: string,
    payload: unknown,
    signature: string | null,
  ): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO webhook_events (source, event_type, payload, signature)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [source, eventType, JSON.stringify(payload), signature],
    );
    return rows[0]!.id;
  }

  /**
   * Enqueue a job. When `dedupeKey` is provided, a duplicate enqueue is a no-op
   * (ON CONFLICT DO NOTHING) — this is how we avoid double-processing when an
   * event is redelivered. Returns the job id, or null when it was a duplicate.
   */
  async enqueueJob(args: {
    type: JobType;
    payload: Record<string, unknown>;
    dedupeKey?: string;
    maxAttempts: number;
    runAfter?: Date;
  }): Promise<string | null> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO jobs (type, payload, dedupe_key, max_attempts, run_after)
       VALUES ($1, $2, $3, $4, COALESCE($5, now()))
       ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        args.type,
        JSON.stringify(args.payload),
        args.dedupeKey ?? null,
        args.maxAttempts,
        args.runAfter ?? null,
      ],
    );
    return rows[0]?.id ?? null;
  }

  /**
   * Atomically claim the next due job (FOR UPDATE SKIP LOCKED) and mark it
   * processing. Safe for multiple concurrent workers.
   */
  async claimNextJob(): Promise<Job | null> {
    const { rows } = await this.pool.query<Job>(
      `UPDATE jobs SET status = 'processing', attempts = attempts + 1, updated_at = now()
       WHERE id = (
         SELECT id FROM jobs
         WHERE status = 'pending' AND run_after <= now()
         ORDER BY run_after
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
    );
    return rows[0] ?? null;
  }

  async completeJob(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE jobs SET status = 'done', last_error = NULL, updated_at = now() WHERE id = $1`,
      [id],
    );
  }

  /** Reschedule for a later retry, or dead-letter when attempts are exhausted. */
  async failJob(id: string, error: string, backoffMs: number): Promise<'retry' | 'dead'> {
    const { rows } = await this.pool.query<{ status: string }>(
      `UPDATE jobs
         SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
             run_after = now() + ($2::int * interval '1 millisecond'),
             last_error = $3,
             updated_at = now()
       WHERE id = $1
       RETURNING status`,
      [id, Math.round(backoffMs), error.slice(0, 4000)],
    );
    return (rows[0]?.status === 'dead' ? 'dead' : 'retry');
  }

  /**
   * Reschedule a job to run later, keeping its attempt count (used by the
   * transcript poll loop to walk TRANSCRIPT_POLL_SCHEDULE_MIN). This is NOT a
   * failure, so it never dead-letters.
   */
  async deferJob(id: string, runAfterMs: number, note: string): Promise<void> {
    await this.pool.query(
      `UPDATE jobs
         SET status = 'pending',
             run_after = now() + ($2::int * interval '1 millisecond'),
             last_error = $3,
             updated_at = now()
       WHERE id = $1`,
      [id, Math.round(runAfterMs), note.slice(0, 4000)],
    );
  }

  async getMappingByAircallContact(aircallContactId: string): Promise<ContactMapping[]> {
    const { rows } = await this.pool.query<ContactMapping>(
      `SELECT aircall_contact_id, jobnimbus_jnid, normalized_phone
         FROM contact_map WHERE aircall_contact_id = $1`,
      [aircallContactId],
    );
    return rows;
  }

  async upsertMapping(m: ContactMapping): Promise<void> {
    await this.pool.query(
      `INSERT INTO contact_map (aircall_contact_id, jobnimbus_jnid, normalized_phone, last_synced_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (aircall_contact_id, normalized_phone)
       DO UPDATE SET jobnimbus_jnid = EXCLUDED.jobnimbus_jnid, last_synced_at = now()`,
      [m.aircall_contact_id, m.jobnimbus_jnid, m.normalized_phone],
    );
  }

  async getProcessedCall(callId: string): Promise<ProcessedCall | null> {
    const { rows } = await this.pool.query<ProcessedCall>(
      `SELECT * FROM processed_calls WHERE aircall_call_id = $1`,
      [callId],
    );
    return rows[0] ?? null;
  }

  async recordProcessedCall(p: {
    aircall_call_id: string;
    normalized_phone: string | null;
    jobnimbus_jnid: string | null;
    jobnimbus_activity_id: string | null;
    jobnimbus_file_id: string | null;
    recording_uploaded: boolean;
    outcome: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO processed_calls (
         aircall_call_id, normalized_phone, jobnimbus_jnid, jobnimbus_activity_id,
         jobnimbus_file_id, recording_uploaded_at, outcome)
       VALUES ($1,$2,$3,$4,$5,
               CASE WHEN $6 THEN now() END,
               $7)
       ON CONFLICT (aircall_call_id) DO UPDATE SET
         normalized_phone = EXCLUDED.normalized_phone,
         jobnimbus_jnid = COALESCE(EXCLUDED.jobnimbus_jnid, processed_calls.jobnimbus_jnid),
         jobnimbus_activity_id = COALESCE(EXCLUDED.jobnimbus_activity_id, processed_calls.jobnimbus_activity_id),
         jobnimbus_file_id = COALESCE(EXCLUDED.jobnimbus_file_id, processed_calls.jobnimbus_file_id),
         recording_uploaded_at = COALESCE(EXCLUDED.recording_uploaded_at, processed_calls.recording_uploaded_at),
         outcome = EXCLUDED.outcome`,
      [
        p.aircall_call_id,
        p.normalized_phone,
        p.jobnimbus_jnid,
        p.jobnimbus_activity_id,
        p.jobnimbus_file_id,
        p.recording_uploaded,
        p.outcome,
      ],
    );
  }

  async getProcessedEstimate(jnid: string): Promise<{ estimate_jnid: string } | null> {
    const { rows } = await this.pool.query<{ estimate_jnid: string }>(
      `SELECT estimate_jnid FROM processed_estimates WHERE estimate_jnid = $1`,
      [jnid],
    );
    return rows[0] ?? null;
  }

  async recordProcessedEstimate(p: {
    estimate_jnid: string;
    signed_amount: number | null;
    slack_channel: string;
    slack_ts: string | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO processed_estimates (estimate_jnid, signed_amount, slack_channel, slack_ts, slack_posted_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (estimate_jnid) DO NOTHING`,
      [p.estimate_jnid, p.signed_amount, p.slack_channel, p.slack_ts],
    );
  }
}
