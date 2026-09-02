import { randomUUID } from 'node:crypto';

import { HSUSD_MINT, type ConfirmedCharge } from '@joinbankroll/sdk/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Charge-only mode: BANKROLL_PAYEE names where money arrives and there is no
// key. Charges must still be checked against that address and against the
// catalog's price; payouts must refuse rather than fail somewhere deeper.
const WALLET = 'BHMwv26hecfUL8rk9XAjgzcDLXM4CBtr1wKNYhEPhSjV';
const PAYEE = 'uhpn1gHscLtCv1vkLSjYNNFXpZyJnGz1ynXWM9WaD7X';

vi.mock('@joinbankroll/sdk/next', () => ({
  Unauthorized: class Unauthorized extends Error {},
  requireIdentity: () => undefined,
  requireSession: () => ({ user: { wallet: WALLET, identity: {}, username: 'tester' } }),
}));

vi.mock('@joinbankroll/sdk/server', async (original) => {
  const actual = await original<typeof import('@joinbankroll/sdk/server')>();
  return {
    ...actual,
    treasuryAddress: () => null,
    requireTreasury: () => {
      throw new Error('no key');
    },
  };
});

const { payeeAddress, payoutsAvailable } = await import('@/lib/app-identity');
const { settle } = await import('@/lib/charges');
const { CATALOG, DEMO_ITEM } = await import('@/lib/catalog');
const { POST: payOut } = await import('@/app/api/charges/[id]/payout/route');
const { POST: startIntent } = await import('@/app/api/charges/intent/route');

const confirmed = (overrides: Partial<ConfirmedCharge> = {}): ConfirmedCharge => ({
  signature: `Sig${randomUUID().replaceAll('-', '')}`,
  payer: WALLET,
  payee: PAYEE,
  mint: HSUSD_MINT,
  amountCents: CATALOG[DEMO_ITEM]!.amountCents,
  memo: null,
  slot: 1,
  ...overrides,
});

beforeEach(() => {
  process.env.BANKROLL_PAYEE = PAYEE;
});

afterEach(() => {
  delete process.env.BANKROLL_PAYEE;
});

describe('the payee without a treasury key', () => {
  it('is the address from BANKROLL_PAYEE, and payouts are off', () => {
    expect(payeeAddress()).toBe(PAYEE);
    expect(payoutsAvailable()).toBe(false);
  });

  it('is nothing when neither is set, and settle refuses to guess', async () => {
    delete process.env.BANKROLL_PAYEE;
    expect(payeeAddress()).toBeNull();
    await expect(settle(WALLET, confirmed())).rejects.toThrow('No payee');
  });
});

describe('settle in charge-only mode', () => {
  it('records a payment to the payee at the expected price', async () => {
    const result = await settle(WALLET, confirmed(), { amountCents: 1, item: DEMO_ITEM });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.charge.meta).toEqual({ item: DEMO_ITEM });
  });

  it('refuses a payment to any other address', async () => {
    const result = await settle(WALLET, confirmed({ payee: WALLET }));
    expect(result).toEqual({ ok: false, reason: 'payment went to another address' });
  });

  it("checks the amount the intent asked for, not the demo's", async () => {
    const result = await settle(WALLET, confirmed({ amountCents: 1 }), { amountCents: 250 });
    expect(result).toEqual({ ok: false, reason: 'payment amount does not match' });
  });
});

describe('routes in charge-only mode', () => {
  it('prices an intent from the catalog and refuses unknown items', async () => {
    const priced = await startIntent(
      new Request('https://app.example/api/charges/intent', {
        method: 'POST',
        body: JSON.stringify({ item: DEMO_ITEM }),
      }),
    );
    expect(priced.status).toBe(200);
    const body = (await priced.json()) as { amountCents: number; item: string; name: string };
    expect(body).toMatchObject({ amountCents: 1, item: DEMO_ITEM, name: 'Demo charge' });

    const unknown = await startIntent(
      new Request('https://app.example/api/charges/intent', {
        method: 'POST',
        body: JSON.stringify({ item: 'yacht' }),
      }),
    );
    expect(unknown.status).toBe(400);
  });

  it('answers a payout with 501 before touching anything', async () => {
    const response = await payOut(new Request('https://app.example/x', { method: 'POST' }), {
      params: Promise.resolve({ id: 'anything' }),
    });
    expect(response.status).toBe(501);
  });
});
