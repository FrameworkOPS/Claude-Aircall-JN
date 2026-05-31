import {
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js';

/**
 * Phone normalization — the part that silently breaks everything.
 *
 * Every number (Aircall side AND JobNimbus side) is normalized to E.164 before
 * any comparison. Matching is ONLY ever done on the E.164 result, never a raw
 * string compare. Extensions, formatting, and leading-1 inconsistencies are all
 * stripped by libphonenumber-js.
 */

/**
 * Normalize an arbitrary phone string to E.164 (e.g. "+12085551234").
 * Returns null when the input cannot be parsed into a valid number.
 *
 * Handles messy real-world inputs: "(208) 555-1234", "12085551234",
 * "+1 208-555-1234", "208.555.1234 x12", etc. Extensions are dropped because
 * E.164 has no concept of an extension.
 */
export function normalizePhone(
  raw: string | null | undefined,
  defaultRegion = 'US',
): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;

  // Strip common extension markers so the parser doesn't choke on them.
  const withoutExt = trimmed.replace(/\b(?:ext|extension|x|#)\.?\s*\d+\s*$/i, '').trim();

  const parsed = parsePhoneNumberFromString(
    withoutExt,
    defaultRegion as CountryCode,
  );
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number; // E.164
}

/**
 * Normalize a list of raw numbers, dropping anything invalid and de-duplicating.
 */
export function normalizePhones(
  raws: Array<string | null | undefined>,
  defaultRegion = 'US',
): string[] {
  const out = new Set<string>();
  for (const r of raws) {
    const n = normalizePhone(r, defaultRegion);
    if (n) out.add(n);
  }
  return [...out];
}

/** True when two raw numbers refer to the same E.164 number. */
export function samePhone(
  a: string | null | undefined,
  b: string | null | undefined,
  defaultRegion = 'US',
): boolean {
  const na = normalizePhone(a, defaultRegion);
  const nb = normalizePhone(b, defaultRegion);
  return na !== null && na === nb;
}

/** Last 4 digits, for safe logging (never log full numbers). */
export function last4(raw: string | null | undefined): string {
  if (raw == null) return '????';
  const digits = String(raw).replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : '????';
}
