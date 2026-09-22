import { afterEach, describe, expect, it, vi } from 'vitest';

import { isGeoBlocked } from '@/lib/geo';

afterEach(() => vi.unstubAllEnvs());

describe('geo blocklist', () => {
  it.each([
    ['US', true],
    ['US-ME', true],
    ['US-MD', false],
    ['US-CA', false],
    ['CA', false],
    ['CA-ON', false],
  ])('matches US,US-ME exactly against %s', (geo, blocked) => {
    vi.stubEnv('BANKROLL_GEO_BLOCKLIST', 'US,US-ME');
    expect(isGeoBlocked(geo)).toBe(blocked);
  });

  it('does not infer a block on country-only geo from a subdivision rule', () => {
    vi.stubEnv('BANKROLL_GEO_BLOCKLIST', 'US-ME');
    expect(isGeoBlocked('US')).toBe(false);
  });

  it('supports alphabetic and numeric subdivision codes outside the US', () => {
    vi.stubEnv('BANKROLL_GEO_BLOCKLIST', 'CA-ON,GB-ENG,FR-75,ES-M');
    for (const geo of ['CA-ON', 'GB-ENG', 'FR-75', 'ES-M'])
      expect(isGeoBlocked(geo)).toBe(true);
    for (const geo of ['CA-QC', 'GB-SCT', 'FR', 'ES'])
      expect(isGeoBlocked(geo)).toBe(false);
  });

  it('normalizes case, whitespace, duplicates and empty CSV entries', () => {
    vi.stubEnv('BANKROLL_GEO_BLOCKLIST', ' us, , us-me,US-ME, ');
    expect(isGeoBlocked(' us ')).toBe(true);
    expect(isGeoBlocked(' us-me ')).toBe(true);
    expect(isGeoBlocked(' us-ca ')).toBe(false);
  });

  it.each([undefined, '', '  ', ' , , '])('disables restrictions for an empty list: %j', (list) => {
    vi.stubEnv('BANKROLL_GEO_BLOCKLIST', list);
    expect(isGeoBlocked('US-ME')).toBe(false);
    expect(isGeoBlocked(undefined)).toBe(false);
    expect(isGeoBlocked(null)).toBe(false);
  });

  it.each([undefined, null, '', '  ', 'US-', 'unknown'])(
    'blocks missing or unusable geo when configured: %j',
    (geo) => {
      vi.stubEnv('BANKROLL_GEO_BLOCKLIST', 'US-ME');
      expect(isGeoBlocked(geo)).toBe(true);
    },
  );

  it.each(['US;US-ME', 'US-*', 'Maine'])('refuses malformed configuration: %s', (list) => {
    vi.stubEnv('BANKROLL_GEO_BLOCKLIST', list);
    expect(() => isGeoBlocked('US-ME')).toThrow('BANKROLL_GEO_BLOCKLIST');
  });
});
