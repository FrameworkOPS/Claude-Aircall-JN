#!/usr/bin/env node
/**
 * One-time migration: re-create existing Aircall contacts with full data
 * (email + company + address) so they become UI-searchable AND show context.
 *
 * Aircall's softphone name-search index ONLY includes contacts that have an
 * email — our earlier backfill pushed name+phone only, so those contacts are
 * findable by phone search but invisible when reps search by name. Empirically
 * confirmed 2026-06-01.
 *
 * For each contact_map row:
 *   1. Get the JN contact (name, phone, email, company, address)
 *   2. Get the current Aircall contact
 *   3. Decide to recreate when EITHER:
 *      - Aircall is missing email AND JN has one (gates UI-searchability), OR
 *      - Aircall is missing information AND JN has an address (enrichment).
 *   4. Delete + recreate with full data; update contact_map.
 *
 * Idempotent: re-runs skip contacts already in good shape.
 *
 * Usage:
 *   node scripts/migrate_aircall_emails.mjs              # dry run
 *   node scripts/migrate_aircall_emails.mjs --live       # execute
 */

import pg from 'pg';
import { buildContext } from '../dist/app.js';
import { closePool } from '../dist/db/pool.js';
import { formatJnAddress } from '../dist/flows/aircallContactPush.js';

const LIVE = process.argv.includes('--live');
const ctx = buildContext();
const { config, repo } = ctx;
// Open our own pg pool for read access (Repo doesn't expose its pool publicly).
const dbPool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  ssl: config.DATABASE_SSL === 'require' ? { rejectUnauthorized: false } : undefined,
});

const AC_BASIC = 'Basic ' + Buffer.from(`${config.AIRCALL_API_ID}:${config.AIRCALL_API_TOKEN}`).toString('base64');

async function ac(method, path, body) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const r = await fetch(`https://api.aircall.io/v1${path}`, {
      method,
      headers: { authorization: AC_BASIC, 'content-type': 'application/json', accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429 || r.status >= 500) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  }
  throw new Error(`Aircall ${method} ${path} retries exhausted`);
}

async function jn(path, params) {
  const url = `${config.JOBNIMBUS_BASE_URL}${path}?${new URLSearchParams(params)}`;
  const r = await fetch(url, {
    headers: { authorization: `Bearer ${config.JOBNIMBUS_API_KEY}`, accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`JN ${path} -> ${r.status}`);
  return r.json();
}

console.log(`MODE: ${LIVE ? '🔴 LIVE WRITES' : '🟢 DRY RUN'}\n`);

console.log('1) Pulling contact_map rows…');
const { rows } = await dbPool.query("select aircall_contact_id, jobnimbus_jnid, normalized_phone from contact_map order by last_synced_at desc");
console.log(`   total mappings: ${rows.length}`);

console.log('\n2) Classifying (skip rows already healthy, find ones that need recreate)…');
let fullyHealthy = 0, nothingToAdd = 0, jnNotFound = 0;
let recreates = 0, fastInfoUpdates = 0, fromScratchCreates = 0;
const work = [];
let idx = 0;
for (const r of rows) {
  idx++;
  if (idx % 50 === 0) process.stdout.write(`   classified ${idx}/${rows.length}\r`);

  // Aircall side (might be 404 if a prior pass deleted but failed to recreate)
  let acContact = null;
  let aircallExists = false;
  try {
    const got = await ac('GET', `/contacts/${r.aircall_contact_id}`);
    if (got.status === 200) { acContact = got.body?.contact; aircallExists = true; }
    else if (got.status === 404) aircallExists = false;
  } catch { aircallExists = false; }

  const acHasEmail = aircallExists && (acContact?.emails ?? []).length > 0;
  const acHasInfo = aircallExists && String(acContact?.information ?? '').trim().length > 0;
  const acCompany = aircallExists ? String(acContact?.company_name ?? '').trim() : '';

  // JN side
  const jnRes = await jn('/contacts', { filter: JSON.stringify({ must: [{ term: { jnid: r.jobnimbus_jnid } }] }), size: '1' });
  const jnContact = (jnRes.results ?? [])[0];
  if (!jnContact) { jnNotFound++; continue; }
  const email = String(jnContact.email ?? '').trim();
  const jnCompany = String(jnContact.company_name ?? '').trim();
  const information = formatJnAddress(jnContact);
  // Show in the Aircall dialer list view: real JN company if present, else the
  // address so reps see context without opening the contact detail.
  const company = jnCompany || information;

  // Decide which path to take.
  let action;
  if (!aircallExists) {
    // Stranded — Aircall lost the contact (failed POST in prior run). Recreate fresh.
    action = 'create_fresh';
    fromScratchCreates++;
  } else if (email && !acHasEmail) {
    // Email is missing -> only way to add it is delete + recreate.
    action = 'recreate';
    recreates++;
  } else if ((information && !acHasInfo) || (company && company !== acCompany)) {
    // Email is fine; fast-update information and/or company_name (both fields
    // accept POST /contacts/:id updates).
    action = 'update_info';
    fastInfoUpdates++;
  } else {
    if (acHasEmail || !email) fullyHealthy++;
    else nothingToAdd++;
    continue;
  }

  // Preserve any data Aircall already has that JN can't supply.
  const finalEmail = email || (acContact?.emails?.[0]?.value ?? '');
  const finalCompany = company || String(acContact?.company_name ?? '').trim();
  const finalInformation = information || String(acContact?.information ?? '').trim();

  work.push({
    action,
    aircallId: r.aircall_contact_id,
    jnid: r.jobnimbus_jnid,
    phone: r.normalized_phone,
    first: String(jnContact.first_name ?? '').trim(),
    last: String(jnContact.last_name ?? '').trim(),
    email: finalEmail,
    company: finalCompany,
    information: finalInformation,
  });
}
process.stdout.write('\n');
console.log(`   fully healthy:                      ${fullyHealthy}`);
console.log(`   no JN email + no JN address (skip): ${nothingToAdd}`);
console.log(`   JN contact missing (skip):          ${jnNotFound}`);
console.log(`   needs CREATE_FRESH (was 404):       ${fromScratchCreates}`);
console.log(`   needs DELETE+RECREATE (add email):  ${recreates}`);
console.log(`   needs FAST UPDATE_INFO (add addr):  ${fastInfoUpdates}`);
console.log(`   total writes:                       ${work.length}`);

console.log('\nSAMPLE (first 10 that will change):');
for (const w of work.slice(0, 10)) {
  console.log(`   [${w.action}]  ${w.phone}  ${w.first} ${w.last}  ${w.information ? '"'+w.information.slice(0,60)+'"' : '(no addr)'}`);
}

if (!LIVE) {
  console.log('\n— dry run only —\n   re-run with --live to execute');
  await dbPool.end().catch(() => {});
  await closePool().catch(() => {});
  process.exit(0);
}

console.log('\n3) EXECUTING delete + recreate…');
let ok = 0, fail = 0;
const failures = [];
const t0 = Date.now();
let n = 0;
for (const w of work) {
  n++;
  try {
    if (w.action === 'update_info') {
      // Fast path: POST information and/or company_name (both accepted by
      // POST /contacts/:id; only emails/phones are silently ignored).
      const patch = {};
      if (w.information) patch.information = w.information;
      if (w.company) patch.company_name = w.company;
      await ac('POST', `/contacts/${w.aircallId}`, patch);
      ok++;
    } else {
      // create_fresh OR recreate (delete+recreate)
      if (w.action === 'recreate') {
        try { await ac('DELETE', `/contacts/${w.aircallId}`); } catch (e) {
          // If DELETE fails, the old contact may still exist — surface and continue.
          throw e;
        }
      }
      const created = await ac('POST', `/contacts`, {
        first_name: w.first,
        last_name: w.last || w.first,
        phone_numbers: [{ label: 'Mobile', value: w.phone }],
        ...(w.email ? { emails: [{ label: 'Work', value: w.email }] } : {}),
        ...(w.company ? { company_name: w.company } : {}),
        ...(w.information ? { information: w.information } : {}),
      });
      const newId = created.body?.contact?.id;
      if (!newId) throw new Error('no new id in response');
      await repo.upsertMapping({
        aircall_contact_id: String(newId),
        jobnimbus_jnid: w.jnid,
        normalized_phone: w.phone,
      });
      ok++;
    }
  } catch (e) {
    fail++;
    failures.push({ phone: w.phone, name: `${w.first} ${w.last}`, action: w.action, err: String(e).slice(0, 160) });
  }
  if (n % 10 === 0 || n === work.length) {
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write(`   ${n}/${work.length}  (ok ${ok} fail ${fail})  ${sec}s\r`);
  }
}
process.stdout.write('\n');
// Tidy up: each delete+recreate leaves the old contact_map row pointing at the
// now-deleted Aircall id. Keep only the most-recent row per phone.
if (ok > 0) {
  const r = await dbPool.query(`
    delete from contact_map a using contact_map b
    where a.normalized_phone = b.normalized_phone
      and (a.last_synced_at < b.last_synced_at
           or (a.last_synced_at = b.last_synced_at and a.aircall_contact_id < b.aircall_contact_id))
  `);
  console.log(`\n  contact_map dedup: deleted ${r.rowCount} older duplicate row(s)`);
}

console.log(`\nDONE in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
console.log(`  recreated: ${ok}`);
console.log(`  failed:    ${fail}`);
if (failures.length) {
  console.log('\nFirst 20 failures:');
  for (const f of failures.slice(0, 20)) console.log(`  [${f.action}] ${f.phone}  ${f.name}  -> ${f.err}`);
}
await closePool().catch(() => {});
