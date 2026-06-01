#!/usr/bin/env node
/**
 * One-time backfill: for every active JobNimbus job, take its primary contact
 * (name + phones) and ensure Aircall has a contact for that number with that
 * name. Updates the Aircall contact when one already exists (via our
 * contact_map first, then Aircall search), creates one otherwise. Persists
 * mappings so re-runs are idempotent.
 *
 * Usage:
 *   node scripts/backfill_aircall_contacts.mjs          # dry run (no writes)
 *   node scripts/backfill_aircall_contacts.mjs --live   # execute
 *
 * Reads config from process.env (same as the deployed service). Source the
 * secrets file before running:
 *   set -a; . /Users/Skyright/aircall-jobnimbus-credentials/secrets.env; set +a
 */

import { buildContext } from '../dist/app.js';
import { closePool } from '../dist/db/pool.js';
import { normalizePhone, last4 } from '../dist/lib/phone.js';

const LIVE = process.argv.includes('--live');
const STUB = 'aircall';
const PHONE_FIELDS = ['mobile_phone', 'home_phone', 'work_phone'];

const ctx = buildContext();
const { config, repo, aircall } = ctx;

/** Direct fetch to JN with the configured key (the JN client doesn't expose pagination). */
async function jn(path, params = {}) {
  const url = `${config.JOBNIMBUS_BASE_URL}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${config.JOBNIMBUS_API_KEY}`, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`JN ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

/** Paginate any JN list endpoint by `from` until empty. */
async function paginate(path, params = {}) {
  const all = [];
  let from = 0;
  const size = 100;
  while (true) {
    const res = await jn(path, { ...params, size: String(size), from: String(from) });
    const recs = res.results ?? res.files ?? [];
    if (recs.length === 0) break;
    all.push(...recs);
    process.stdout.write(`  ${path}: ${all.length}\r`);
    if (recs.length < size) break;
    from += size;
  }
  process.stdout.write(`\n`);
  return all;
}

console.log(`MODE: ${LIVE ? '🔴 LIVE WRITES' : '🟢 DRY RUN (no Aircall writes)'}`);
console.log(`Phone region: ${config.DEFAULT_PHONE_REGION}\n`);

console.log('1) Pulling all active JobNimbus jobs…');
const jobs = await paginate('/jobs', { filter: JSON.stringify({ must: [{ term: { is_active: true } }] }) });
console.log(`   active jobs: ${jobs.length}`);

console.log('\n2) Collecting unique primary contact jnids from jobs…');
const wantedContactIds = new Set();
let jobsWithNoPrimary = 0;
for (const j of jobs) {
  const id = j.primary?.id;
  if (id) wantedContactIds.add(id);
  else jobsWithNoPrimary++;
}
console.log(`   unique contact jnids: ${wantedContactIds.size}  (jobs missing primary: ${jobsWithNoPrimary})`);

console.log('\n3) Scanning JN contacts to pull those primaries (one pass, paginated)…');
const wantedContacts = [];
const foundIds = new Set();
let scannedContacts = 0;
let from = 0;
// JN's /contacts pagination drops a few records at size=100; size=200 is reliable.
const size = 200;
while (foundIds.size < wantedContactIds.size) {
  const res = await jn('/contacts', { size: String(size), from: String(from) });
  const recs = res.results ?? [];
  if (recs.length === 0) break;
  scannedContacts += recs.length;
  for (const c of recs) if (wantedContactIds.has(c.jnid) && c.is_active !== false) {
    if (!foundIds.has(c.jnid)) { wantedContacts.push(c); foundIds.add(c.jnid); }
  }
  process.stdout.write(`   scanned ${scannedContacts}, matched ${foundIds.size}/${wantedContactIds.size}\r`);
  if (recs.length < size) break;
  from += size;
}
process.stdout.write('\n');

// Backstop: any wanted jnid the bulk scan missed -> fetch directly by jnid filter
// (we've confirmed {term:{jnid}} resolves any active contact reliably). This is
// how we recover from JN's pagination dropping records (Adam West / Paul Satchwell).
const missing = [...wantedContactIds].filter((id) => !foundIds.has(id));
if (missing.length > 0) {
  console.log(`   bulk scan missed ${missing.length} contact(s); fetching by jnid…`);
  for (const id of missing) {
    const r = await jn('/contacts', { filter: JSON.stringify({ must: [{ term: { jnid: id } }] }), size: '1' });
    const c = (r.results ?? [])[0];
    if (c && c.is_active !== false) { wantedContacts.push(c); foundIds.add(id); }
  }
  console.log(`   recovered ${foundIds.size} / ${wantedContactIds.size} after direct fetch`);
}
console.log(`   matched contacts: ${wantedContacts.length} (of ${wantedContactIds.size} unique referenced)`);

console.log('\n4) Building unique phone -> name map (E.164 normalized)…');
const phoneMap = new Map(); // e164 -> { firstName, lastName, contactJnid }
const reasons = { no_phone: 0, no_name: 0, stub_name: 0, unparseable: 0 };
for (const c of wantedContacts) {
  const first = String(c.first_name ?? '').trim();
  const last = String(c.last_name ?? '').trim();
  if (!first && !last) { reasons.no_name++; continue; }
  if (first.toLowerCase() === STUB) { reasons.stub_name++; continue; }
  let foundPhone = false;
  for (const f of PHONE_FIELDS) {
    const raw = c[f];
    if (!raw) continue;
    const e164 = normalizePhone(String(raw), config.DEFAULT_PHONE_REGION);
    if (!e164) { reasons.unparseable++; continue; }
    foundPhone = true;
    // First writer wins, but prefer entries that have a last name to those that don't.
    const existing = phoneMap.get(e164);
    if (!existing || (!existing.lastName && last)) {
      phoneMap.set(e164, { firstName: first, lastName: last, contactJnid: c.jnid });
    }
  }
  if (!foundPhone) reasons.no_phone++;
}
console.log(`   unique phones to sync:        ${phoneMap.size}`);
console.log(`   skipped — no phone fields:     ${reasons.no_phone}`);
console.log(`   skipped — no name:             ${reasons.no_name}`);
console.log(`   skipped — stub "Aircall":      ${reasons.stub_name}`);
console.log(`   non-parseable phone strings:   ${reasons.unparseable}`);

console.log('\n5) Pre-loading every existing Aircall contact (avoids search-lag duplicates)…');
const AC_BASIC = 'Basic ' + Buffer.from(`${config.AIRCALL_API_ID}:${config.AIRCALL_API_TOKEN}`).toString('base64');
async function loadAllAircallContacts() {
  const phoneToId = new Map();
  let page = 1;
  const perPage = 50;
  while (true) {
    const r = await fetch(`https://api.aircall.io/v1/contacts?per_page=${perPage}&page=${page}&order=asc`, {
      headers: { authorization: AC_BASIC, accept: 'application/json' },
    });
    if (r.status === 429) { await new Promise(s => setTimeout(s, 2000)); continue; }
    if (!r.ok) throw new Error(`Aircall /contacts list page ${page} -> ${r.status} ${await r.text()}`);
    const j = await r.json();
    const contacts = j.contacts ?? [];
    if (contacts.length === 0) break;
    for (const c of contacts) {
      for (const pn of c.phone_numbers ?? []) {
        const e164 = normalizePhone(String(pn.value || ''), config.DEFAULT_PHONE_REGION);
        if (e164 && !phoneToId.has(e164)) phoneToId.set(e164, String(c.id));
      }
    }
    process.stdout.write(`   Aircall contacts loaded: page ${page}, total mapped phones ${phoneToId.size}\r`);
    if (contacts.length < perPage) break;
    page++;
  }
  process.stdout.write('\n');
  return phoneToId;
}
const aircallPhoneToId = await loadAllAircallContacts();
console.log(`   Aircall has ${aircallPhoneToId.size} unique phones across existing contacts`);

console.log('\n6) Classifying create vs update against the Aircall snapshot (dry-run preview)…');
const phoneList = [...phoneMap.entries()];
let willUpdate = 0;
const samples = [];
for (const [phone, info] of phoneList) {
  const acId = aircallPhoneToId.get(phone);
  if (acId) willUpdate++;
  if (samples.length < 10) samples.push({ phone, ...info, acId });
}
const willCreate = phoneList.length - willUpdate;
console.log(`   will UPDATE existing Aircall contact:  ${willUpdate}`);
console.log(`   will CREATE new Aircall contact:       ${willCreate}`);

console.log('\nSAMPLE (first 10):');
for (const s of samples) {
  console.log(`   ${s.phone}  (last4 ${last4(s.phone)})  ->  ${s.firstName} ${s.lastName}  ${s.acId ? '[UPDATE id ' + s.acId + ']' : '[CREATE]'}`);
}

if (!LIVE) {
  console.log('\n— dry run only, no Aircall writes —');
  console.log('   to execute: re-run with --live');
  await closePool().catch(() => {});
  process.exit(0);
}

console.log('\n7) EXECUTING backfill against live Aircall…');
let ok = 0, created = 0, updated = 0, fail = 0;
const failures = [];
const t0 = Date.now();
let idx = 0;
for (const [phone, info] of phoneList) {
  idx++;
  try {
    const acId = aircallPhoneToId.get(phone);
    let resultId;
    if (acId) {
      const u = await aircall.updateContact(acId, { firstName: info.firstName, lastName: info.lastName });
      resultId = u.id ?? acId;
      updated++;
    } else {
      const c = await aircall.createContact({
        firstName: info.firstName,
        lastName: info.lastName || info.firstName,
        phone,
      });
      resultId = c.id;
      created++;
      // remember it in case a later JN contact in this same run shares the phone
      aircallPhoneToId.set(phone, String(resultId));
    }
    await repo.upsertMapping({
      aircall_contact_id: String(resultId),
      jobnimbus_jnid: info.contactJnid,
      normalized_phone: phone,
    });
    ok++;
  } catch (e) {
    fail++;
    failures.push({ phone, name: `${info.firstName} ${info.lastName}`, err: String(e).slice(0, 160) });
  }
  if (idx % 10 === 0 || idx === phoneList.length) {
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write(`   ${idx}/${phoneList.length}  (ok ${ok}: created ${created}, updated ${updated}; fail ${fail})  ${sec}s\r`);
  }
}
console.log('');
console.log(`\nDONE in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`);
console.log(`  total:    ${phoneList.length}`);
console.log(`  ok:       ${ok}   (created ${created}, updated ${updated})`);
console.log(`  failed:   ${fail}`);
if (failures.length) {
  console.log('\nFirst 20 failures:');
  for (const f of failures.slice(0, 20)) console.log(`  ${f.phone}  ${f.name}  -> ${f.err}`);
}
await closePool().catch(() => {});
