import { randomUUID } from 'node:crypto';

import { HSUSD_MINT } from '@joinbankroll/sdk/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The route's whole job is deciding which transaction may exist and when it is
// sent, so the chain is mocked and the store is real — what matters is which
// bytes go out and what the document says at each step, not that Solana works.
const sdk = vi.hoisted(() => ({
  built: 0,
  sent: [] as string[],
  keys: [] as string[],
  sendFails: null as string | null,
  confirmFails: null as string | null,
  found: null as null | { signature: string; slot: number; failed: boolean },
  builtInputs: [] as Array<{ to: string; amountCents: number; memo?: string; token?: string; reference?: string }>,
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
    // A keypair treasury for these tests; the server-wallet shape is covered below.
    treasuryAddress: () => 'Trea5ury',
    requireTreasury: () => ({ address: 'Trea5ury', sendTransaction: async () => 'sig' }),
    delegatedPrivySigner: (options?: { idempotencyKey?: string }) => {
      sdk.keys.push(options?.idempotencyKey ?? '');
      return { address: process.env.BANKROLL_PAYEE ?? '', sendTransaction: async () => 'sig' };
    },
    createReference: () => `ref-${sdk.built + 1}`,
    buildPayout: async (input: { to: string; amountCents: number; memo?: string; token?: string; reference?: string }) => {
      sdk.built += 1;
      sdk.builtInputs.push(input);
      return { transaction: `tx-${sdk.built}`, lastValidBlockHeight: 1000 + sdk.built, blockhash: `hash-${sdk.built}` };
    },
    sendPayout: async (transaction: string) => {
      if (sdk.sendFails) throw new actual.PayError(sdk.sendFails as never, 'nope');
      sdk.sent.push(transaction);
      return { signature: `sig-${transaction}` };
    },
    findPayoutByReference: async () => sdk.found,
    confirmPayout: async () => {
      if (sdk.confirmFails) throw new actual.PayError(sdk.confirmFails as never, 'nope');
    },
  };
});

const WALLET = 'BHMwv26hecfUL8rk9XAjgzcDLXM4CBtr1wKNYhEPhSjV';

const { POST } = await import('@/app/api/charges/[id]/payout/route');
const { recordCharge, getCharge, updateCharge } = await import('@/lib/store');
const { payeeAddress, payoutSigner, payoutsAvailable, ownerAddress, serverWalletConfigured } = await import('@/lib/treasury');

const payOut = (id: string) =>
  POST(new Request('https://app.example/x', { method: 'POST' }), {
    params: Promise.resolve({ id }),
  });

async function charge(meta?: Record<string, unknown>) {
  const { charge } = await recordCharge(WALLET, randomUUID(), 1, 100, HSUSD_MINT, meta);
  return charge.id;
}

// An attempt another call recorded and sent, dying before it stored the
// signature — the crash window the reference exists for.
const unsignedAttempt = { reference: 'ref-x', idempotencyKey: 'key-x', transaction: 'tx-x' };
async function recordUnsigned(id: string) {
  await updateCharge(WALLET, id, (current) => ({ ...current, status: 'paying', payout: unsignedAttempt }));
}

const SERVER_WALLET_ENV = {
  BANKROLL_PAYEE: 'ServerWa11et111111111111111111111111111111111',
  BANKROLL_DELEGATED_KEY: 'wallet-auth:KEY',
  BANKROLL_DELEGATED_WALLET_ID: 'wallet_1',
  BANKROLL_PRIVY_APP_ID: 'privy_app',
  BANKROLL_OWNER: 'Creator1111111111111111111111111111111111111',
};

beforeEach(() => {
  sdk.built = 0;
  sdk.sent = [];
  sdk.keys = [];
  sdk.sendFails = null;
  sdk.confirmFails = null;
  sdk.found = null;
  sdk.builtInputs = [];
  for (const key of Object.keys(SERVER_WALLET_ENV)) delete process.env[key];
});

describe('paying a charge back out', () => {
  it('builds one payout and pays it', async () => {
    const id = await charge();
    const response = await payOut(id);

    expect(response.status).toBe(200);
    expect(sdk.built).toBe(1);
    expect(sdk.sent).toEqual(['tx-1']);
    expect(sdk.builtInputs[0]).toMatchObject({ to: WALLET, amountCents: 100, token: HSUSD_MINT, reference: 'ref-1' });
    const stored = await getCharge(WALLET, id);
    expect(stored?.status).toBe('paid');
    expect(stored?.payout?.signature).toBe('sig-tx-1');
  });

  it('pays what the app recorded as owed, and settles a zero without a transfer', async () => {
    const prize = await charge({ owedCents: 250 });
    await payOut(prize);
    expect(sdk.builtInputs[0]).toMatchObject({ amountCents: 250 });

    const loss = await charge({ owedCents: 0 });
    const response = await payOut(loss);
    expect(response.status).toBe(200);
    expect(sdk.built).toBe(1);
    expect((await getCharge(WALLET, loss))?.status).toBe('paid');
  });

  // THE invariant: the attempt — reference, key, bytes — is durable before the
  // broadcast, so a send that dies leaves something the chain can be asked
  // about — never money moving under an attempt the document doesn't know.
  it('stores the attempt before broadcasting', async () => {
    const id = await charge();
    sdk.sendFails = 'send_failed';

    const response = await payOut(id);
    expect(response.status).toBe(202);
    expect(sdk.sent).toEqual([]);

    const stored = await getCharge(WALLET, id);
    expect(stored?.status).toBe('paying');
    expect(stored?.payout).toMatchObject({ reference: 'ref-1', idempotencyKey: `payout:${id}:ref-1`, transaction: 'tx-1' });
    expect(stored?.payout?.signature).toBeUndefined();
    expect(stored?.payout?.error).toBe('send_failed');
  });

  it('records an unconfirmed payout without marking it paid', async () => {
    const id = await charge();
    sdk.confirmFails = 'confirmation_timeout';

    const response = await payOut(id);
    expect(response.status).toBe(202);

    const stored = await getCharge(WALLET, id);
    expect(stored?.status).toBe('paying');
    expect(stored?.payout?.signature).toBe('sig-tx-1');
    expect(stored?.payout?.error).toBe('confirmation_timeout');
  });

  // `failed_on_chain` — it landed and failed, so no funds moved — is the one
  // outcome that licenses a fresh transaction.
  it('rebuilds only a payout that landed and failed', async () => {
    const id = await charge();
    sdk.confirmFails = 'failed_on_chain';
    await payOut(id);
    expect(sdk.sent).toEqual(['tx-1']);

    sdk.confirmFails = null;
    const retry = await payOut(id);

    expect(retry.status).toBe(200);
    expect(sdk.built).toBe(2);
    expect(sdk.sent).toEqual(['tx-1', 'tx-2']);
    expect((await getCharge(WALLET, id))?.payout?.signature).toBe('sig-tx-2');
  });

  // Anything short of `failed_on_chain` leaves the outcome unknown. The retry
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
  });

  it('recovers a sent-but-unrecorded attempt by its reference', async () => {
    const id = await charge();
    await recordUnsigned(id);
    sdk.found = { signature: 'landed-sig', slot: 1, failed: false };

    const response = await payOut(id);

    expect(response.status).toBe(200);
    expect(sdk.built).toBe(0);
    expect(sdk.sent).toEqual([]);
    expect((await getCharge(WALLET, id))?.payout?.signature).toBe('landed-sig');
  });

  it('resends the recorded bytes under the same key when nothing landed', async () => {
    const id = await charge();
    await recordUnsigned(id);

    const response = await payOut(id);

    expect(response.status).toBe(200);
    expect(sdk.built).toBe(0);
    expect(sdk.sent).toEqual(['tx-x']);
    expect((await getCharge(WALLET, id))?.payout?.signature).toBe('sig-tx-x');
  });

  it('is idempotent once paid', async () => {
    const id = await charge();
    await payOut(id);
    const again = await payOut(id);

    expect(again.status).toBe(200);
    expect(sdk.built).toBe(1);
  });
});

describe('a Bankroll server wallet', () => {
  beforeEach(() => {
    Object.assign(process.env, SERVER_WALLET_ENV);
  });

  it('is the payee, pays out, and is owned by BANKROLL_OWNER', () => {
    expect(serverWalletConfigured()).toBe(true);
    expect(payeeAddress()).toBe(SERVER_WALLET_ENV.BANKROLL_PAYEE);
    expect(payoutsAvailable()).toBe(true);
    expect(ownerAddress()).toBe(SERVER_WALLET_ENV.BANKROLL_OWNER);
  });

  it('signs each attempt with the delegated signer under its idempotency key', async () => {
    const signer = payoutSigner('payout:1:ref');
    expect(signer.address).toBe(SERVER_WALLET_ENV.BANKROLL_PAYEE);
    expect(sdk.keys).toEqual(['payout:1:ref']);

    const id = await charge();
    await payOut(id);
    expect(sdk.keys).toEqual(['payout:1:ref', `payout:${id}:ref-1`, `payout:${id}:ref-1`]);
  });
});
