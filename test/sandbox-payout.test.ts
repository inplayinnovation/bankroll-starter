import { randomUUID } from 'node:crypto';

import { HSUSD_MINT } from '@joinbankroll/sdk/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// What a coding agent's dev server is: BANKROLL_MOCK=1, the server wallet's
// payee and id but never its key. A payout must complete the way a charge
// does under the mock — a made-up signature, no money — so the agent sees
// payouts as part of the app. Only buildPayout is stubbed: it would ask an
// RPC for a blockhash; send and confirm run for real through the mock.
vi.mock('@joinbankroll/sdk/next', () => ({
  Unauthorized: class Unauthorized extends Error {},
  requireIdentity: () => undefined,
  requireSession: () => ({ user: { wallet: WALLET, identity: {}, username: 'tester' } }),
}));
vi.mock('@joinbankroll/sdk/server', async (original) => {
  const actual = await original<typeof import('@joinbankroll/sdk/server')>();
  return {
    ...actual,
    buildPayout: async () => ({ transaction: 'AQ==', lastValidBlockHeight: 1, blockhash: 'h' }),
  };
});

const WALLET = 'BHMwv26hecfUL8rk9XAjgzcDLXM4CBtr1wKNYhEPhSjV';
const SANDBOX_ENV = {
  BANKROLL_MOCK: '1',
  BANKROLL_PAYEE: 'ServerWa11et111111111111111111111111111111111',
  BANKROLL_OWNER: 'Creator1111111111111111111111111111111111111',
  BANKROLL_DELEGATED_WALLET_ID: 'wallet_1',
};

const { POST } = await import('@/app/api/charges/[id]/payout/route');
const { recordCharge, getCharge } = await import('@/lib/store');
const { payoutsAvailable } = await import('@/lib/treasury');

beforeEach(() => Object.assign(process.env, SANDBOX_ENV));
afterEach(() => {
  for (const key of Object.keys(SANDBOX_ENV)) delete process.env[key];
});

describe("a coding agent's dev server", () => {
  it('reports payouts available and pays a charge out with a mock signature, no key involved', async () => {
    expect(payoutsAvailable()).toBe(true);
    const { charge } = await recordCharge(WALLET, randomUUID(), 1, 100, HSUSD_MINT);

    const response = await POST(new Request('https://app.example/x', { method: 'POST' }), {
      params: Promise.resolve({ id: charge.id }),
    });

    expect(response.status).toBe(200);
    const stored = await getCharge(WALLET, charge.id);
    expect(stored?.status).toBe('paid');
    expect(stored?.payout?.signature?.startsWith('mock-payout-')).toBe(true);
  });
});
