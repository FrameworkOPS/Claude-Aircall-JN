import type { AppContext } from '../context';
import type { JnContact } from '../clients/jobnimbus';
import { normalizePhone } from '../lib/phone';

const STUB_FIRST = 'aircall';
// Aircall's CSV import format (per their help docs): exact column order matters.
//   first_name, last_name, company_name, phone1, phone2, phone3, phone4, email
export const AIRCALL_CSV_HEADERS = [
  'first_name',
  'last_name',
  'company_name',
  'phone1',
  'phone2',
  'phone3',
  'phone4',
  'email',
] as const;

function csvCell(v: unknown): string {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Stream every active JobNimbus contact that has a name + valid phone to a
 * caller-supplied `write(line)` callback in Aircall's CSV import format.
 *
 * Skips: stubs (first_name="Aircall"), phone-shaped last names (test artifacts),
 * contacts with no name, contacts with no parseable phones, duplicates by phone.
 *
 * Returns counts so callers can log or surface a "wrote N contacts" header.
 */
export async function streamAircallContactsCsv(
  ctx: AppContext,
  write: (line: string) => void,
): Promise<{ rows: number; skipped: number }> {
  const { config } = ctx;
  const jnBase = config.JOBNIMBUS_BASE_URL;
  const headers = { authorization: `Bearer ${config.JOBNIMBUS_API_KEY}`, accept: 'application/json' };

  // Header row first so the file is valid even mid-stream if cancelled.
  write(AIRCALL_CSV_HEADERS.join(','));

  const seenPhones = new Set<string>();
  let rows = 0;
  let skipped = 0;

  // Paginate /contacts at size=200 (size=100 silently drops records — seen
  // 1287/1290 in the bulk backfill).
  let from = 0;
  const size = 200;
  while (true) {
    const url = `${jnBase}/contacts?` + new URLSearchParams({ size: String(size), from: String(from) });
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`JN /contacts -> ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { results?: JnContact[] };
    const recs = body.results ?? [];
    if (recs.length === 0) break;

    for (const c of recs) {
      if (c.is_active === false) { skipped++; continue; }
      const first = String(c.first_name ?? '').trim();
      const last = String(c.last_name ?? '').trim();
      if (!first && !last) { skipped++; continue; }
      if (first.toLowerCase() === STUB_FIRST) { skipped++; continue; }
      if (/^\+?\d{7,}$/.test(last)) { skipped++; continue; }

      const phones: string[] = [];
      for (const f of ['mobile_phone', 'home_phone', 'work_phone'] as const) {
        const raw = (c as Record<string, unknown>)[f];
        if (!raw) continue;
        const e164 = normalizePhone(String(raw), config.DEFAULT_PHONE_REGION);
        if (e164 && !seenPhones.has(e164) && !phones.includes(e164)) phones.push(e164);
      }
      if (phones.length === 0) { skipped++; continue; }
      phones.forEach((p) => seenPhones.add(p));

      const line = [
        first,
        last,
        String(c.company_name ?? '').trim(),
        phones[0] ?? '',
        phones[1] ?? '',
        phones[2] ?? '',
        phones[3] ?? '',
        String(c.email ?? '').trim(),
      ].map(csvCell).join(',');
      write(line);
      rows++;
    }

    if (recs.length < size) break;
    from += size;
  }

  return { rows, skipped };
}
