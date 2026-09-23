import type { BankrollSession } from '@joinbankroll/sdk/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { paidPlayRestriction } from '@/lib/restrictions';

afterEach(() => vi.unstubAllEnvs());

const BLOCKS_MAINE = JSON.stringify({
  version: 1,
  geo: { default: 'allow', countries: { US: { block: ['ME'] } } },
});

function session(geo?: string, identity: BankrollSession['user']['identity'] = { age: 30 }): BankrollSession {
  return {
    iss: 'https://joinbankroll.com',
    aud: 'https://game.example',
    iat: 1_800_000_000,
    exp: 1_800_000_900,
    user: { wallet: 'player', username: 'tester', identity },
    ...(geo === undefined ? {} : { geo }),
  };
}

describe('paid play restriction', () => {
  it('is none without a policy', () => {
    vi.stubEnv('BANKROLL_RESTRICTIONS', '');
    expect(paidPlayRestriction(session())).toEqual({ reason: null, minimumAge: null });
    expect(paidPlayRestriction(session('US-ME', false))).toEqual({ reason: null, minimumAge: null });
  });

  it('decides from the verified location and age', () => {
    vi.stubEnv('BANKROLL_RESTRICTIONS', BLOCKS_MAINE);
    expect(paidPlayRestriction(session('US-ME'))).toEqual({ reason: 'location_blocked', minimumAge: 18 });
    expect(paidPlayRestriction(session('US-CA'))).toEqual({ reason: null, minimumAge: 18 });
    expect(paidPlayRestriction(session('US-CA', { age: 17 })).reason).toBe('age_under_minimum');
  });

  it('refuses when the policy needs a location or an age the session lacks', () => {
    vi.stubEnv('BANKROLL_RESTRICTIONS', BLOCKS_MAINE);
    expect(paidPlayRestriction(session()).reason).toBe('location_unknown');
    expect(paidPlayRestriction(session('US')).reason).toBe('location_unknown');
    expect(paidPlayRestriction(session('US-CA', false)).reason).toBe('age_unknown');
    expect(paidPlayRestriction(session('US-CA', {})).reason).toBe('age_unknown');
  });

  it('refuses a malformed policy instead of allowing play', () => {
    vi.stubEnv('BANKROLL_RESTRICTIONS', 'US,US-ME');
    expect(() => paidPlayRestriction(session('US-CA'))).toThrow('BANKROLL_RESTRICTIONS');
  });
});
