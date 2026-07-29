import { randomUUID } from 'node:crypto';

import { HSUSD_MINT } from '@joinbankroll/sdk/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The route's whole job is deciding which transaction to broadcast, so the
// chain is mocked and the store is real — what matters is which bytes come out,
// not that Solana works.
const sdk = vi.hoisted(() => ({
  built: 0,
  sent: [] as string[],
  confirmFails: null as string | null,
}));

vi.mock('@joinbankroll/sdk/next', () => ({
  Unauthorized: class Unauthorized extends Error {},
  requireIdentity: () => undefined,
  requireSession: () => ({ user: { wallet: WALLET, identity: {}, username: 'tester' } }),
}));

vi.mock('@joinbankroll/sdk/server', async (original) => {
  const actual = await original<typeof import('@joinbankroll/sdk/server')>();
  return {
    ...actual,
    requireTreasury: () => ({ address: 'Trea5ury', sendTransaction: async () => 'sig' }),
    buildPayout: async () => {
      sdk.built += 1;
      return { transaction: `tx-${sdk.built}`, lastValidBlockHeight: 1000 + sdk.built };
    },
    sendPayout: async (transaction: string) => {
      sdk.sent.push(transaction);
      return { signature: `sig-${sdk.sent.length}` };
    },
    confirmPayout: async () => {
      if (sdk.confirmFails) throw new actual.PayError(sdk.confirmFails as never, 'nope');
    },
  };
});

const WALLET = 'BHMwv26hecfUL8rk9XAjgzcDLXM4CBtr1wKNYhEPhSjV';

const { POST } = await import('@/app/api/charges/[id]/payout/route');
const { recordCharge, getCharge } = await import('@/lib/store');

const payOut = (id: string) =>
  POST(new Request('https://app.example/x', { method: 'POST' }), {
    params: Promise.resolve({ id }),
  });

async function charge() {
  const { charge } = await recordCharge(WALLET, randomUUID(), 1, 100, HSUSD_MINT);
  return charge.id;
}

beforeEach(() => {
  sdk.built = 0;
  sdk.sent = [];
  sdk.confirmFails = null;
});

describe('paying a charge back out', () => {
  it('builds one payout and pays it', async () => {
    const id = await charge();
    const response = await payOut(id);

    expect(response.status).toBe(200);
    expect(sdk.built).toBe(1);
    expect((await getCharge(WALLET, id))?.status).toBe('paid');
  });

  // A payout that did not confirm may still land, so the bytes are kept and the
  // charge stays open rather than being paid a second time.
  it('records an unconfirmed payout without marking it paid', async () => {
    const id = await charge();
    sdk.confirmFails = 'expired';

    const response = await payOut(id);
    expect(response.status).toBe(202);

    const stored = await getCharge(WALLET, id);
    expect(stored?.status).toBe('paying');
    expect(stored?.payout?.error).toBe('expired');
  });

  // The bug this exists for: an expired transaction can never land, so
  // re-broadcasting the recorded bytes left the charge `paying` forever and the
  // app showing "paying…" with no way out.
  it('rebuilds an expired payout instead of resending it', async () => {
    const id = await charge();
    sdk.confirmFails = 'expired';
    await payOut(id);
    expect(sdk.sent).toEqual(['tx-1']);

    sdk.confirmFails = null;
    const retry = await payOut(id);

    expect(retry.status).toBe(200);
    // A second build, and the new bytes went out — not the dead ones.
    expect(sdk.built).toBe(2);
    expect(sdk.sent).toEqual(['tx-1', 'tx-2']);
    expect((await getCharge(WALLET, id))?.status).toBe('paid');
  });

  // Anything other than expiry leaves the outcome unknown, and rebuilding then
  // could pay twice — so those bytes are resent exactly.
  it('resends the same bytes when the outcome is unknown', async () => {
    const id = await charge();
    sdk.confirmFails = 'rpc_error';
    await payOut(id);

    sdk.confirmFails = null;
    await payOut(id);

    expect(sdk.built).toBe(1);
    expect(sdk.sent).toEqual(['tx-1', 'tx-1']);
  });

  it('is idempotent once paid', async () => {
    const id = await charge();
    await payOut(id);
    const again = await payOut(id);

    expect(again.status).toBe(200);
    expect(sdk.built).toBe(1);
  });
});
