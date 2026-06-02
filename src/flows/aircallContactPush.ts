import type { AppContext } from '../context';
import type { JnContact } from '../clients/jobnimbus';
import { normalizePhone, last4 } from '../lib/phone';
import { isStub } from './dedupe';

export interface AircallContactPushPayload {
  /** Preferred: the JobNimbus contact jnid to read name + phone from. */
  jobnimbus_contact_jnid?: string;
  /** Optional direct values if the JN automation sends them inline. */
  phone?: string;
  first_name?: string;
  last_name?: string;
}

/**
 * Flow B — JobNimbus job created -> push the (now real) customer name back to
 * Aircall as a contact for that number, so future calls show the name.
 *
 * - Resolve the JobNimbus contact (fetch by jnid, or use inline fields).
 * - Skip if the contact is still an unfilled "Aircall" stub (no real name yet).
 * - Dedup on the Aircall side via our persisted phone->aircall_contact_id map
 *   (Aircall's own search index lags), falling back to a best-effort search;
 *   update if known, otherwise create. Persist the mapping either way.
 */
export async function pushAircallContact(
  ctx: AppContext,
  payload: AircallContactPushPayload,
): Promise<void> {
  const { logger, repo, aircall, jobnimbus, config } = ctx;
  const log = logger.child({ flow: 'aircall_contact_push' });

  let contact: JnContact | null = null;
  if (payload.jobnimbus_contact_jnid) {
    contact = await jobnimbus.getContact(payload.jobnimbus_contact_jnid);
  } else if (payload.first_name || payload.last_name || payload.phone) {
    contact = {
      jnid: 'inline',
      first_name: payload.first_name,
      last_name: payload.last_name,
      mobile_phone: payload.phone,
    } as JnContact;
  }

  if (!contact) {
    log.warn('no JobNimbus contact jnid or inline fields in payload; skipping');
    return;
  }

  const rawPhone =
    contact.mobile_phone || contact.home_phone || contact.work_phone || payload.phone || '';
  const e164 = normalizePhone(rawPhone, config.DEFAULT_PHONE_REGION);
  if (!e164) {
    log.warn({ jnid: contact.jnid }, 'JobNimbus contact has no parseable phone; skipping');
    return;
  }

  if (isStub(contact)) {
    log.info(
      { jnid: contact.jnid, phone_last4: last4(e164) },
      'JobNimbus contact is still an unfilled Aircall stub; not pushing to Aircall yet',
    );
    return;
  }

  const firstName = (contact.first_name ?? '').trim();
  const lastName = (contact.last_name ?? '').trim();
  if (!firstName && !lastName) {
    log.info({ jnid: contact.jnid }, 'JobNimbus contact has no name; skipping Aircall push');
    return;
  }

  // Pull email + company too — Aircall's UI name-search index only includes
  // contacts with an email. Phone+name only = not searchable in the softphone.
  const email = String(contact.email ?? '').trim();
  const company = String(contact.company_name ?? '').trim();

  // Reliable dedup: our own phone -> aircall_contact_id map, then best-effort search.
  const mapped = await repo.getMappingByPhone(e164);
  let aircallId: string | undefined = mapped.find((m) => m.aircall_contact_id)?.aircall_contact_id;
  if (!aircallId) {
    const found = await aircall.searchContactByPhone(e164);
    if (found[0]?.id) aircallId = String(found[0].id);
  }

  let resultId: number | string;
  if (aircallId) {
    // POST /contacts/:id only updates names; emails/phones are silently ignored.
    // If the JN contact has an email, we must delete+recreate so it ends up in
    // the UI search index. Otherwise a plain name update is fine.
    if (email) {
      try { await aircall.deleteContact(aircallId); } catch (err) {
        log.warn({ err: String(err), aircallId }, 'aircall delete-before-recreate failed; proceeding');
      }
      const created = await aircall.createContact({
        firstName, lastName: lastName || firstName, phone: e164, email, company: company || undefined,
      });
      resultId = created.id;
      log.info({ aircall_contact_id: String(resultId), phone_last4: last4(e164), search_indexable: true }, 'recreated Aircall contact with full data');
    } else {
      const updated = await aircall.updateContact(aircallId, { firstName, lastName });
      resultId = updated.id ?? aircallId;
      log.info({ aircall_contact_id: String(resultId), phone_last4: last4(e164), search_indexable: false }, 'updated Aircall contact name (no email, not UI-searchable)');
    }
  } else {
    const created = await aircall.createContact({
      firstName, lastName: lastName || firstName, phone: e164,
      email: email || undefined,
      company: company || undefined,
    });
    resultId = created.id;
    log.info({ aircall_contact_id: String(resultId), phone_last4: last4(e164), search_indexable: Boolean(email) }, 'created Aircall contact');
  }

  await repo.upsertMapping({
    aircall_contact_id: String(resultId),
    jobnimbus_jnid: contact.jnid,
    normalized_phone: e164,
  });
}
