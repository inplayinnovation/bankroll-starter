import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSession } from '@joinbankroll/sdk/next';
import type { BankrollSession } from '@joinbankroll/sdk/server';

import { GET } from '@/app/api/me/route';

vi.mock('@joinbankroll/sdk/next', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/treasury', () => ({ payeeAddress: () => 'treasury' }));

const BLOCKS_MAINE = JSON.stringify({
  version: 1,
  geo: { default: 'allow', countries: { US: { block: ['ME'] } } },
});

beforeEach(() => vi.stubEnv('BANKROLL_RESTRICTIONS', BLOCKS_MAINE));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function session(geo?: string): BankrollSession {
  return {
    iss: 'https://joinbankroll.com',
    aud: 'https://game.example',
    iat: 1_800_000_000,
    exp: 1_800_000_900,
    user: { wallet: 'player', username: 'tester', identity: { age: 30 } },
    ...(geo === undefined ? {} : { geo }),
  };
}

describe('/api/me paid play restriction', () => {
  it('requires a verified session before reporting eligibility', async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const response = await GET(new Request('https://game.example/api/me'));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });

  it('uses the verified location even when the request supplies an allowed location', async () => {
    vi.mocked(getSession).mockResolvedValue(session('US-ME'));
    const response = await GET(new Request('https://game.example/api/me?geo=US-CA', {
      headers: { 'x-geo': 'US-CA', 'x-vercel-ip-country-region': 'CA' },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      username: 'tester', wallet: 'player', geo: 'US-ME', restriction: { reason: 'location_blocked', minimumAge: 18 },
    });
  });

  it('reports another US state as allowed', async () => {
    vi.mocked(getSession).mockResolvedValue(session('US-CA'));
    const response = await GET(new Request('https://game.example/api/me'));
    expect(await response.json()).toMatchObject({ geo: 'US-CA', restriction: { reason: null, minimumAge: 18 } });
  });

  it('reports missing location as blocked while keeping session details available', async () => {
    vi.mocked(getSession).mockResolvedValue(session());
    const response = await GET(new Request('https://game.example/api/me'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      geo: null, restriction: { reason: 'location_unknown' }, username: 'tester',
    });
  });

  it('allows missing location when the restriction is disabled', async () => {
    vi.stubEnv('BANKROLL_RESTRICTIONS', '');
    vi.mocked(getSession).mockResolvedValue(session());
    const response = await GET(new Request('https://game.example/api/me'));
    expect(await response.json()).toMatchObject({ geo: null, restriction: { reason: null, minimumAge: null } });
  });
});
