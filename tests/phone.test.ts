import { normalizePhone, normalizePhones, samePhone, last4 } from '../src/lib/phone';

describe('normalizePhone', () => {
  const cases: Array<[string, string | null]> = [
    ['(208) 555-1234', '+12085551234'],
    ['12085551234', '+12085551234'],
    ['+1 208-555-1234', '+12085551234'],
    ['208.555.1234 x12', '+12085551234'],
    ['208-555-1234 ext. 99', '+12085551234'],
    ['  +12085551234  ', '+12085551234'],
    ['2085551234', '+12085551234'],
  ];

  it.each(cases)('normalizes %s -> %s', (input, expected) => {
    expect(normalizePhone(input, 'US')).toBe(expected);
  });

  it('returns null for empty / garbage / null', () => {
    expect(normalizePhone('', 'US')).toBeNull();
    expect(normalizePhone('   ', 'US')).toBeNull();
    expect(normalizePhone('not a phone', 'US')).toBeNull();
    expect(normalizePhone(null, 'US')).toBeNull();
    expect(normalizePhone(undefined, 'US')).toBeNull();
  });

  it('returns null for too-short numbers', () => {
    expect(normalizePhone('12345', 'US')).toBeNull();
  });

  it('respects an international number with country code regardless of region', () => {
    expect(normalizePhone('+44 20 7946 0958', 'US')).toBe('+442079460958');
  });
});

describe('normalizePhones', () => {
  it('drops invalid and de-duplicates', () => {
    const out = normalizePhones(['(208) 555-1234', '12085551234', 'garbage', ''], 'US');
    expect(out).toEqual(['+12085551234']);
  });
});

describe('samePhone', () => {
  it('matches differently-formatted equivalents', () => {
    expect(samePhone('(208) 555-1234', '+1 208 555 1234', 'US')).toBe(true);
    expect(samePhone('2085551234', '12085551234', 'US')).toBe(true);
  });
  it('does not match different numbers', () => {
    expect(samePhone('2085551234', '2085551235', 'US')).toBe(false);
  });
  it('never matches when either side is invalid', () => {
    expect(samePhone('garbage', '2085551234', 'US')).toBe(false);
    expect(samePhone(null, null, 'US')).toBe(false);
  });
});

describe('last4', () => {
  it('returns last four digits only', () => {
    expect(last4('+12085551234')).toBe('1234');
    expect(last4('(208) 555-1234')).toBe('1234');
  });
  it('handles short / missing input safely', () => {
    expect(last4('12')).toBe('????');
    expect(last4(null)).toBe('????');
  });
});
