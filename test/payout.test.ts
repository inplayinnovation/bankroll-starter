import { randomUUID } from 'node:crypto';

import { HSUSD_MINT } from '@joinbankroll/sdk/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The route's whole job is deciding which transaction may exist and when it is
// sent, so the chain is mocked and the store is real — what matters is which
// bytes go out and what the document says at each step, not that Solana works.
const sdk = vi.hoisted(() => ({
  built: 0,
  sent: [] as string[],
  sendFails: null as string | null,
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
    treasuryAddress: () => 'Trea5ury',
    requireTreasury: () => ({ address: 'Trea5ury', sendTransaction: async () => 'sig' }),
    buildAndSignPayout: async () => {
      sdk.built += 1;
      return {
        transaction: `tx-${sdk.built}`,
        signature: `sig-${sdk.built}`,
        lastValidBlockHeight: 1000 + sdk.built,
        blockhash: `hash-${sdk.built}`,
      };
    },
    sendPayout: async (transaction: string) => {
      if (sdk.sendFails) throw new actual.PayError(sdk.sendFails as never, 'nope');
      sdk.sent.push(transaction);
      return { signature: 'broadcast-echo' };
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
  sdk.sendFails = null;
  sdk.confirmFails = null;
});

describe('paying a charge back out', () => {
  it('builds one payout and pays it', async () => {
    const id = await charge();
    const response = await payOut(id);

    expect(response.status).toBe(200);
    expect(sdk.built).toBe(1);
    expect(sdk.sent).toEqual(['tx-1']);
    expect((await getCharge(WALLET, id))?.status).toBe('paid');
  });

  // THE invariant: the signature is durable before the broadcast, so a send
  // that dies leaves an outcome the chain can be asked about — never money
  // moving under an id the document doesn't know.
  it('stores the signature before broadcasting', async () => {
    const id = await charge();
    sdk.sendFails = 'send_failed';

    const response = await payOut(id);
    expect(response.status).toBe(202);
    expect(sdk.sent).toEqual([]);

    const stored = await getCharge(WALLET, id);
    expect(stored?.status).toBe('paying');
    expect(stored?.payout?.signature).toBe('sig-1');
  });

  // A payout that did not confirm may still land, so the charge stays open
  // rather than being paid a second time.
  it('records an unconfirmed payout without marking it paid', async () => {
    const id = await charge();
    sdk.confirmFails = 'expired';

    const response = await payOut(id);
    expect(response.status).toBe(202);

    const stored = await getCharge(WALLET, id);
    expect(stored?.status).toBe('paying');
    expect(stored?.payout?.error).toBe('expired');
  });

  // `expired` is ledger-searched proof the attempt never landed and never
  // can — the one outcome that licenses a fresh transaction.
  it('rebuilds an expired payout', async () => {
    const id = await charge();
    sdk.confirmFails = 'expired';
    await payOut(id);
    expect(sdk.sent).toEqual(['tx-1']);

    sdk.confirmFails = null;
    const retry = await payOut(id);

    expect(retry.status).toBe(200);
    // A second build went out — under a second recorded signature.
    expect(sdk.built).toBe(2);
    expect(sdk.sent).toEqual(['tx-1', 'tx-2']);
    expect((await getCharge(WALLET, id))?.status).toBe('paid');
    expect((await getCharge(WALLET, id))?.payout?.signature).toBe('sig-2');
  });

  // Anything short of `expired` leaves the outcome unknown. The retry
  // resolves the STORED signature — it never sends again and never rebuilds.
  it('resolves an unknown outcome by the stored signature, not a resend', async () => {
    const id = await charge();
    sdk.confirmFails = 'rpc_error';
    await payOut(id);

    sdk.confirmFails = null;
    const retry = await payOut(id);

    expect(retry.status).toBe(200);
    expect(sdk.built).toBe(1);
    expect(sdk.sent).toEqual(['tx-1']);
    expect((await getCharge(WALLET, id))?.status).toBe('paid');
  });

  it('is idempotent once paid', async () => {
    const id = await charge();
    await payOut(id);
    const again = await payOut(id);

    expect(again.status).toBe(200);
    expect(sdk.built).toBe(1);
  });
});
