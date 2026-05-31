import type { AppContext } from '../context';
import type { JnContact } from '../clients/jobnimbus';
import { normalizePhone, last4 } from '../lib/phone';

export interface AircallContactPayload {
  id: number | string;
  first_name?: string | null;
  last_name?: string | null;
  company_name?: string | null;
  emails?: Array<{ label?: string; value: string }>;
  phone_numbers?: Array<{ label?: string; value: string }>;
}

/** Map an Aircall phone (by label) onto a JobNimbus phone field. */
function mapPhoneField(label: string | undefined): keyof JnContact {
  const l = (label ?? '').toLowerCase();
  if (l.includes('work') || l.includes('office')) return 'work_phone';
  if (l.includes('home')) return 'home_phone';
  return 'mobile_phone';
}

function buildContactBody(contact: AircallContactPayload, region: string): Partial<JnContact> {
  const body: Partial<JnContact> = {};
  if (contact.first_name) body.first_name = contact.first_name;
  if (contact.last_name) body.last_name = contact.last_name;
  const display = [contact.first_name, contact.last_name].filter(Boolean).join(' ').trim();
  if (display) body.display_name = display;
  else if (contact.company_name) body.display_name = contact.company_name;

  for (const p of contact.phone_numbers ?? []) {
    const e164 = normalizePhone(p.value, region);
    if (!e164) continue;
    const field = mapPhoneField(p.label);
    // Don't clobber an already-set field of the same type with a second number.
    if (!body[field]) (body as Record<string, unknown>)[field] = e164;
  }
  return body;
}

/**
 * Flow 1 — contact sync + dedup ("merge" = dedup-on-write + conflict flagging).
 *
 * - Normalize every phone to E.164.
 * - Search JobNimbus by each phone.
 * - One distinct match  -> UPDATE it (no duplicate created).
 * - No match            -> CREATE it.
 * - Multiple distinct   -> DUPLICATE_CONFLICT: log both jnids, write nothing.
 * Mapping recorded in contact_map for every normalized phone.
 */
export async function syncContact(ctx: AppContext, contact: AircallContactPayload): Promise<void> {
  const { logger, repo, jobnimbus, config } = ctx;
  const aircallContactId = String(contact.id);
  const log = logger.child({ flow: 'contact_sync', aircall_contact_id: aircallContactId });

  const phones = (contact.phone_numbers ?? [])
    .map((p) => normalizePhone(p.value, config.DEFAULT_PHONE_REGION))
    .filter((p): p is string => p !== null);
  const uniquePhones = [...new Set(phones)];

  if (uniquePhones.length === 0) {
    log.warn('contact has no valid phone numbers; skipping (phone is the match key)');
    return;
  }

  // Gather all JobNimbus contacts matching any of the contact's phones.
  const matched = new Map<string, JnContact>();
  for (const phone of uniquePhones) {
    for (const c of await jobnimbus.findContactsByPhone(phone)) {
      matched.set(c.jnid, c);
    }
  }

  const body = buildContactBody(contact, config.DEFAULT_PHONE_REGION);
  const phoneLog = { phones_last4: uniquePhones.map(last4) };

  if (matched.size > 1) {
    log.warn(
      { ...phoneLog, jnids: [...matched.keys()] },
      'DUPLICATE_CONFLICT: phone(s) match multiple JobNimbus contacts; skipping write (no safe merge API)',
    );
    return;
  }

  let jnid: string;
  if (matched.size === 1) {
    jnid = [...matched.keys()][0]!;
    await jobnimbus.updateContact(jnid, body);
    log.info({ ...phoneLog, jnid }, 'updated existing JobNimbus contact (dedup)');
  } else {
    const created = await jobnimbus.createContact(body);
    jnid = created.jnid;
    log.info({ ...phoneLog, jnid }, 'created JobNimbus contact');
  }

  for (const phone of uniquePhones) {
    await repo.upsertMapping({
      aircall_contact_id: aircallContactId,
      jobnimbus_jnid: jnid,
      normalized_phone: phone,
    });
  }
}
