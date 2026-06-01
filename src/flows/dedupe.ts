import type { AppContext } from '../context';
import type { JnContact } from '../clients/jobnimbus';
import { last4 } from '../lib/phone';

/** A contact whose first name is exactly this is an unfilled call stub. */
export const STUB_FIRST_NAME = 'Aircall';

export function isStub(c: JnContact): boolean {
  return (c.first_name ?? '').trim().toLowerCase() === STUB_FIRST_NAME.toLowerCase();
}

export type ResolveOutcome =
  | 'matched'
  | 'created_stub'
  | 'merged'
  | 'manual_review'
  | 'unparseable'
  | 'none';

export interface ResolveResult {
  contact: JnContact | null;
  outcome: ResolveOutcome;
}

/** Fields we try to carry from duplicates onto the surviving primary. */
const MERGEABLE_FIELDS = [
  'first_name',
  'last_name',
  'email',
  'mobile_phone',
  'home_phone',
  'work_phone',
  'address_line1',
  'city',
  'state_text',
  'zip',
] as const;

/**
 * Resolve the single canonical JobNimbus contact for a phone number, applying
 * the "safe auto-merge" policy:
 *
 *  - 0 matches  -> create an "Aircall / <E.164>" stub (when createStubIfMissing).
 *  - 1 match    -> use it.
 *  - N matches  -> pick a primary (real name beats stub; then more jobs; then
 *                  oldest), copy missing fields onto it, ARCHIVE empty stub
 *                  duplicates, and flag any real/with-jobs collisions for a
 *                  human (never auto-archive those — JobNimbus has no merge API).
 *
 * Always idempotent and never destroys a contact that has jobs.
 */
export async function resolveCanonicalContact(
  ctx: AppContext,
  e164: string,
  opts: { createStubIfMissing: boolean },
): Promise<ResolveResult> {
  const { jobnimbus, logger } = ctx;
  const contacts = await jobnimbus.findContactsByPhone(e164);

  if (contacts.length === 0) {
    if (!opts.createStubIfMissing) return { contact: null, outcome: 'none' };
    const stub = await jobnimbus.createContact({
      first_name: STUB_FIRST_NAME,
      last_name: e164,
      display_name: `${STUB_FIRST_NAME} ${e164}`,
      mobile_phone: e164,
    });
    logger.info({ jnid: stub.jnid, phone_last4: last4(e164) }, 'created Aircall stub contact');
    return { contact: stub, outcome: 'created_stub' };
  }

  if (contacts.length === 1) return { contact: contacts[0]!, outcome: 'matched' };

  return mergeDuplicates(ctx, e164, contacts);
}

async function mergeDuplicates(
  ctx: AppContext,
  e164: string,
  contacts: JnContact[],
): Promise<ResolveResult> {
  const { jobnimbus, logger } = ctx;
  const phone_last4 = last4(e164);

  // Annotate each candidate with stub-ness and job count.
  const annotated = await Promise.all(
    contacts.map(async (c) => ({
      c,
      stub: isStub(c),
      jobs: (await jobnimbus.getRelatedJobs(c.jnid)).length,
      created: Number(c.date_created ?? 0),
    })),
  );

  // Primary preference: real (non-stub) first, then more jobs, then oldest.
  const sorted = [...annotated].sort((a, b) => {
    if (a.stub !== b.stub) return a.stub ? 1 : -1;
    if (a.jobs !== b.jobs) return b.jobs - a.jobs;
    return (a.created || Infinity) - (b.created || Infinity);
  });
  const primary = sorted[0]!;
  const dups = sorted.slice(1);

  // Copy any field the primary is missing from a duplicate (never overwrite).
  const patch: Record<string, unknown> = {};
  for (const d of dups) {
    for (const f of MERGEABLE_FIELDS) {
      const cur = (primary.c as Record<string, unknown>)[f];
      const alt = (d.c as Record<string, unknown>)[f];
      if ((cur === undefined || cur === null || cur === '') && alt) patch[f] = alt;
    }
  }
  // Never let a stub's last_name (the phone number) clobber a real surname.
  if (primary.stub) delete patch.first_name;
  if (Object.keys(patch).length > 0) {
    await jobnimbus.updateContact(primary.c.jnid, patch as Partial<JnContact>);
  }

  const archived: string[] = [];
  const flagged: string[] = [];
  for (const d of dups) {
    if (d.stub && d.jobs === 0) {
      await jobnimbus.archiveContact(d.c.jnid);
      archived.push(d.c.jnid);
    } else {
      flagged.push(d.c.jnid);
    }
  }

  if (flagged.length > 0) {
    logger.warn(
      { phone_last4, primary: primary.c.jnid, flagged, archived },
      'DUPLICATE_CONFLICT: phone on multiple real/with-job contacts; archived empty stubs, flagged the rest for manual merge',
    );
    return { contact: primary.c, outcome: 'manual_review' };
  }

  logger.info(
    { phone_last4, primary: primary.c.jnid, archived },
    'merged duplicate stub contacts into primary',
  );
  return { contact: primary.c, outcome: 'merged' };
}
