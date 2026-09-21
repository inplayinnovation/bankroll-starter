import { createMatchmaking } from '@joinbankroll/sdk/matchmaking';
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { mockBuiltPayout, mockPayoutSigner, mockReference } from '@joinbankroll/sdk/mock';
import {
  buildAndSignPayout,
  buildPayout,
  ChargeMismatchError,
  checkCharge,
  confirmPayout,
  createManagedReference,
  createTimer,
  findPayoutByReference,
  PayError,
  sendPayout,
  type PaymentSigner,
} from '@joinbankroll/sdk/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBankrollPrimitives, PayoutReceiptMismatch, type PreparedPayout } from '../bankroll';

vi.mock('@joinbankroll/sdk/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@joinbankroll/sdk/server')>()),
  buildAndSignPayout: vi.fn(),
  buildPayout: vi.fn(),
  checkCharge: vi.fn(),
  confirmPayout: vi.fn(),
  createManagedReference: vi.fn(),
  createTimer: vi.fn(),
  findPayoutByReference: vi.fn(),
  sendPayout: vi.fn(),
}));

vi.mock('@joinbankroll/sdk/matchmaking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@joinbankroll/sdk/matchmaking')>()),
  createMatchmaking: vi.fn(),
}));

const now = 1_800_000_000_000;
const payee = 'treasury';
const origin = 'https://duel.test';
const input = {
  id: 'attempt-1',
  reference: 'reference-1',
  payee,
  recipients: [{ to: 'winner', amountCents: 180, token: 'mint' }],
  memo: 'match:one',
};
const signed: PreparedPayout = {
  id: input.id,
  reference: input.reference,
  transaction: 'fixed-signed-bytes',
  signature: 'fixed-signature',
  lastValidBlockHeight: 500,
  mode: 'signed',
};

const address = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
function hostedTransaction(
  change: {
    recipient?: number;
    amount?: number;
    mint?: number;
    memo?: string;
    blockhash?: number;
    sponsor?: boolean;
    compute?: boolean;
    extraTransfer?: boolean;
    treasurySigns?: boolean;
  } = {},
) {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0); // SPL transferChecked: amount and decimals are part of the signed instruction.
  data.writeBigUInt64LE(BigInt(change.amount ?? 1_800_000_000), 1);
  data.writeUInt8(9, 9);
  const transfer = new TransactionInstruction({
    programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    keys: [
      { pubkey: address(2), isSigner: false, isWritable: true },
      { pubkey: address(change.mint ?? 3), isSigner: false, isWritable: false },
      { pubkey: address(change.recipient ?? 4), isSigner: false, isWritable: true },
      { pubkey: address(1), isSigner: change.treasurySigns ?? true, isWritable: true },
      { pubkey: address(5), isSigner: false, isWritable: false },
    ],
    data,
  });
  const tx = new Transaction({
    feePayer: address(change.sponsor ? 8 : 1),
    recentBlockhash: address(change.blockhash ?? 6).toBase58(),
  });
  if (change.compute) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
  tx.add(transfer);
  if (change.extraTransfer) tx.add(transfer);
  tx.add(
    new TransactionInstruction({
      programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
      keys: [],
      data: Buffer.from(change.memo ?? input.memo),
    }),
  );
  return tx;
}
const hostedWire = hostedTransaction()
  .serialize({ requireAllSignatures: false, verifySignatures: false })
  .toString('base64');
const hosted: PreparedPayout = {
  ...signed,
  transaction: hostedWire,
  signature: null,
  lastValidBlockHeight: null,
  mode: 'hosted',
};

const inspectTransaction = vi.spyOn(Connection.prototype, 'getTransaction');
function receipt(tx = hostedTransaction(), signature = 'found-signature') {
  return {
    blockTime: now / 1_000,
    slot: 12,
    meta: { err: null, fee: 5_000, preBalances: [], postBalances: [] },
    transaction: { signatures: [signature], message: tx.compileMessage() },
  };
}

const hostedSigner = (): PaymentSigner => ({
  address: payee,
  sendTransaction: vi.fn().mockResolvedValue('hosted-signature'),
  replayWindowMs: 86_400_000,
});
const localSigner = (): PaymentSigner => ({
  address: payee,
  sendTransaction: vi.fn().mockResolvedValue(signed.signature),
  signTransaction: vi.fn().mockReturnValue({
    transaction: signed.transaction,
    signature: signed.signature,
  }),
});
const adapter = (signer = localSigner()) => {
  const payoutSigner = vi.fn(() => signer);
  return { payoutSigner, api: createBankrollPrimitives({ payoutSigner, now: () => now }) };
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('BANKROLL_MOCK', '0');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Payment adapter tests must stay offline');
    }),
  );
  vi.mocked(buildAndSignPayout).mockResolvedValue({
    transaction: signed.transaction,
    signature: signed.signature!,
    lastValidBlockHeight: signed.lastValidBlockHeight!,
    blockhash: 'fixed-blockhash',
  });
  vi.mocked(buildPayout).mockResolvedValue({
    transaction: hosted.transaction,
    lastValidBlockHeight: 500,
    blockhash: 'temporary-blockhash',
  });
  vi.mocked(sendPayout).mockResolvedValue({ signature: signed.signature! });
  vi.mocked(confirmPayout).mockResolvedValue(undefined);
  vi.mocked(findPayoutByReference).mockResolvedValue(null);
  inspectTransaction.mockResolvedValue(receipt());
  vi.mocked(createManagedReference).mockResolvedValue({
    reference: 'reference-1',
    expiresAt: 'later',
  });
  vi.mocked(createTimer).mockResolvedValue({ id: 'timer-1', at: 'later' });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('signed payout execution', () => {
  it('prepares once and replays persisted bytes with the same identity after adapter restart', async () => {
    const signer = localSigner();
    const first = adapter(signer);
    const attempt = await first.api.prepare(input);
    expect(attempt).toEqual(signed);
    expect(buildAndSignPayout).toHaveBeenCalledWith(
      { reference: input.reference, recipients: input.recipients, memo: input.memo },
      { signer },
    );

    await first.api.send(attempt, payee);
    const restarted = adapter(signer);
    await restarted.api.send(JSON.parse(JSON.stringify(attempt)), payee);
    expect(sendPayout).toHaveBeenNthCalledWith(1, signed.transaction, { signer });
    expect(sendPayout).toHaveBeenNthCalledWith(2, signed.transaction, { signer });
    expect(restarted.payoutSigner).toHaveBeenCalledWith(attempt.id);
    expect(buildAndSignPayout).toHaveBeenCalledTimes(1);
    expect(buildPayout).not.toHaveBeenCalled();
  });

  it('reconciles the persisted signature using actual chain validity evidence', async () => {
    expect(await adapter().api.reconcile(signed)).toEqual({
      status: 'paid',
      signature: signed.signature,
    });
    expect(confirmPayout).toHaveBeenCalledWith(signed.signature, { lastValidBlockHeight: 500 });
    expect(findPayoutByReference).not.toHaveBeenCalled();
  });

  it.each(['failed_on_chain', 'expired'] as const)(
    'permits replacement only on conclusive SDK evidence: %s',
    async (code) => {
      vi.mocked(confirmPayout).mockRejectedValue(new PayError(code, 'proven unable to pay'));
      expect(await adapter().api.reconcile(signed)).toEqual({ status: 'retryable' });
      expect(sendPayout).not.toHaveBeenCalled();
      expect(createTimer).not.toHaveBeenCalled();
    },
  );

  it('rejects an unrelated signature before checking the chain', async () => {
    await expect(adapter().api.verify(signed, 'different-signature')).rejects.toThrow(
      'recorded transaction',
    );
    expect(confirmPayout).not.toHaveBeenCalled();
  });

  it('still requires chain confirmation for the matching signature', async () => {
    const error = new PayError('confirmation_timeout', 'not confirmed yet');
    vi.mocked(confirmPayout).mockRejectedValue(error);
    await expect(adapter().api.verify(signed, signed.signature!)).rejects.toBe(error);
    expect(confirmPayout).toHaveBeenCalledWith(signed.signature, { lastValidBlockHeight: 500 });
  });

  it('does not infer safe retirement from an incomplete persisted attempt', async () => {
    await expect(
      adapter().api.reconcile({ ...signed, lastValidBlockHeight: null }),
    ).rejects.toThrow('last valid block height');
    expect(confirmPayout).not.toHaveBeenCalled();
  });

  it('rejects a sender returning a different transaction identity', async () => {
    vi.mocked(sendPayout).mockResolvedValue({ signature: 'different-signature' });
    await expect(adapter().api.send(signed, payee)).rejects.toThrow(
      'different transaction signature',
    );
  });
});

describe('hosted payout execution', () => {
  it('does not mistake the unsigned build height for the provider transaction lifetime', async () => {
    const signer = hostedSigner();
    expect(await adapter(signer).api.prepare(input)).toEqual(hosted);
    expect(buildPayout).toHaveBeenCalledWith(
      { reference: input.reference, recipients: input.recipients, memo: input.memo },
      { signer },
    );
    expect(buildAndSignPayout).not.toHaveBeenCalled();
  });

  it('preserves absent receipt evidence as unresolved without sending or registering a retry timer', async () => {
    expect(await adapter(hostedSigner()).api.reconcile(hosted)).toEqual({ status: 'unresolved' });
    expect(findPayoutByReference).toHaveBeenCalledWith(hosted.reference);
    expect(confirmPayout).not.toHaveBeenCalled();
    expect(sendPayout).not.toHaveBeenCalled();
    expect(buildPayout).not.toHaveBeenCalled();
    expect(createTimer).not.toHaveBeenCalled();
  });

  it('reconciles a known submitted signature without the unsigned build height', async () => {
    const attempt = { ...hosted, signature: 'returned-signature' };
    expect(await adapter(hostedSigner()).api.reconcile(attempt)).toEqual({
      status: 'paid',
      signature: attempt.signature,
    });
    expect(confirmPayout).toHaveBeenCalledWith(attempt.signature, undefined);
    expect(findPayoutByReference).not.toHaveBeenCalled();
  });

  it('recovers a lost send reply from reference discovery and confirmation', async () => {
    vi.mocked(findPayoutByReference).mockResolvedValue({
      signature: 'found-signature',
      slot: 12,
      failed: false,
    });
    expect(await adapter(hostedSigner()).api.reconcile(hosted)).toEqual({
      status: 'paid',
      signature: 'found-signature',
    });
    expect(confirmPayout).toHaveBeenCalledWith('found-signature', undefined);
    expect(inspectTransaction).toHaveBeenCalledWith('found-signature', {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    expect(sendPayout).not.toHaveBeenCalled();
  });

  it('does not permit a new hosted attempt on a failed candidate transaction', async () => {
    vi.mocked(findPayoutByReference).mockResolvedValue({
      signature: 'failed-signature',
      slot: 12,
      failed: true,
    });
    expect(await adapter(hostedSigner()).api.reconcile(hosted)).toEqual({ status: 'unresolved' });
    expect(confirmPayout).not.toHaveBeenCalled();
  });

  it.each(['failed_on_chain', 'expired'] as const)(
    'does not invent provider retirement guarantees from %s',
    async (code) => {
      vi.mocked(confirmPayout).mockRejectedValue(new PayError(code, 'failed receipt'));
      expect(
        await adapter(hostedSigner()).api.reconcile({ ...hosted, signature: 'returned-signature' }),
      ).toEqual({ status: 'unresolved' });
      expect(sendPayout).not.toHaveBeenCalled();
    },
  );

  it('correlates an unknown confirmation with the reference before accepting it', async () => {
    vi.mocked(findPayoutByReference).mockResolvedValue({
      signature: 'found-signature',
      slot: 12,
      failed: false,
    });
    const { api } = adapter(hostedSigner());
    await expect(api.verify(hosted, 'unrelated-signature')).rejects.toThrow('its reference');
    expect(confirmPayout).not.toHaveBeenCalled();
    await api.verify(hosted, 'found-signature');
    expect(confirmPayout).toHaveBeenCalledWith('found-signature', undefined);
  });

  it.each([false, true])(
    'accepts blockhash/compute-budget updates and sponsorship=%s when payout instructions remain intact',
    async (sponsor) => {
      vi.mocked(findPayoutByReference).mockResolvedValue({
        signature: 'found-signature',
        slot: 12,
        failed: false,
      });
      inspectTransaction.mockResolvedValue(
        receipt(hostedTransaction({ blockhash: 7, compute: true, sponsor })),
      );
      expect(await adapter(hostedSigner()).api.reconcile(hosted)).toEqual({
        status: 'paid',
        signature: 'found-signature',
      });
      await adapter(hostedSigner()).api.verify(hosted, 'found-signature');
    },
  );

  it.each([
    { recipient: 9 },
    { amount: 1 },
    { mint: 9 },
    { memo: 'another payout' },
    { extraTransfer: true },
    { sponsor: true, treasurySigns: false },
  ])('refuses to discharge a hosted obligation for modified transaction %j', async (change) => {
    vi.mocked(findPayoutByReference).mockResolvedValue({
      signature: 'found-signature',
      slot: 12,
      failed: false,
    });
    inspectTransaction.mockResolvedValue(receipt(hostedTransaction(change)));
    const { api } = adapter(hostedSigner());
    expect(await api.reconcile(hosted)).toEqual({ status: 'unresolved' });
    await expect(api.verify(hosted, 'found-signature')).rejects.toBeInstanceOf(
      PayoutReceiptMismatch,
    );
    expect(sendPayout).not.toHaveBeenCalled();
  });

  it('propagates missing transaction history instead of acknowledging permanent ambiguity', async () => {
    vi.mocked(findPayoutByReference).mockResolvedValue({
      signature: 'found-signature',
      slot: 12,
      failed: false,
    });
    inspectTransaction.mockResolvedValue(null);
    const { api } = adapter(hostedSigner());
    await expect(api.reconcile(hosted)).rejects.toMatchObject({ code: 'rpc_error' });
    await expect(api.verify(hosted, 'found-signature')).rejects.toMatchObject({
      code: 'rpc_error',
    });
    inspectTransaction.mockRejectedValue(new Error('RPC disconnected'));
    await expect(api.reconcile(hosted)).rejects.toMatchObject({ code: 'rpc_error' });
  });

  it('refuses to resend a hosted attempt with a saved submission response', async () => {
    await expect(
      adapter(hostedSigner()).api.send({ ...hosted, signature: 'returned-signature' }, payee),
    ).rejects.toThrow('not resent');
    expect(sendPayout).not.toHaveBeenCalled();
  });
});

describe('transient errors preserve webhook retry', () => {
  it.each(['rpc_error', 'confirmation_timeout', 'send_failed'] as const)(
    'propagates %s for both signer modes rather than acknowledging a stuck debt',
    async (code) => {
      const error = new PayError(code, 'retry this delivery');
      vi.mocked(confirmPayout).mockRejectedValue(error);
      await expect(adapter().api.reconcile(signed)).rejects.toBe(error);
      await expect(
        adapter(hostedSigner()).api.reconcile({ ...hosted, signature: 'known' }),
      ).rejects.toBe(error);
      expect(createTimer).not.toHaveBeenCalled();
    },
  );

  it('does not turn unavailable reference history into absence', async () => {
    const error = new PayError('rpc_error', 'history unavailable');
    vi.mocked(findPayoutByReference).mockRejectedValue(error);
    await expect(adapter(hostedSigner()).api.reconcile(hosted)).rejects.toBe(error);
    await expect(adapter(hostedSigner()).api.verify(hosted, 'candidate')).rejects.toBe(error);
  });

  it('preserves a send error and its transaction evidence for the engine', async () => {
    const error = new PayError('rpc_error', 'send response lost', { signature: signed.signature! });
    vi.mocked(sendPayout).mockRejectedValue(error);
    await expect(adapter().api.send(signed, payee)).rejects.toBe(error);
    expect(buildPayout).not.toHaveBeenCalled();
  });
});

describe('SDK and treasury boundaries', () => {
  it('rejects a changed treasury before preparing or sending', async () => {
    const { api } = adapter({ ...localSigner(), address: 'different-treasury' });
    await expect(api.prepare(input)).rejects.toThrow('recorded treasury');
    await expect(api.send(signed, payee)).rejects.toThrow('recorded treasury');
    expect(buildAndSignPayout).not.toHaveBeenCalled();
    expect(sendPayout).not.toHaveBeenCalled();
  });

  it('rejects changed signer capabilities on a persisted attempt', async () => {
    await expect(adapter(hostedSigner()).api.send(signed, payee)).rejects.toThrow(
      'capabilities changed',
    );
    expect(sendPayout).not.toHaveBeenCalled();
  });

  it('preserves reference routing, watch window and origin', async () => {
    const meta = { kind: 'payout', id: 'one', baseRevision: 3 };
    await adapter().api.reference({ origin, meta, expiresInSeconds: 900 });
    expect(createManagedReference).toHaveBeenCalledWith(
      { meta, expiresInSeconds: 900 },
      { origin },
    );
  });

  it.each([
    [60_001, 2],
    [60_000, 1],
    [-500, 1],
  ])('rounds a deadline %i ms away to %i minute(s)', async (delay, minutes) => {
    const meta = { kind: 'game', token: 'one', baseRevision: 2 };
    await adapter().api.timer({ origin, meta, dueAt: now + delay });
    expect(createTimer).toHaveBeenCalledWith({ meta, firesInMinutes: minutes }, { origin });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, now + 43_201 * 60_000])(
    'rejects unusable timer deadline %s',
    (dueAt) => {
      expect(() => adapter().api.timer({ origin, meta: {}, dueAt })).toThrow('deadline');
      expect(createTimer).not.toHaveBeenCalled();
    },
  );

  it('preserves expected payment facts and the actual mismatching receipt', async () => {
    const expected = { payer: 'player', payee, mint: 'mint', amountCents: 100, memo: 'entry:one' };
    const received = { ...expected, signature: 'charge-signature', amountCents: 150, slot: 2 };
    const error = new ChargeMismatchError(received, 'amountCents');
    vi.mocked(checkCharge).mockRejectedValue(error);
    await expect(adapter().api.charge(received.signature, expected)).rejects.toBe(error);
    expect(checkCharge).toHaveBeenCalledWith(received.signature, expected);
    expect(error.charge).toEqual(received);
  });

  it('binds the matchmaking client to the app origin', () => {
    adapter().api.matchmaking(origin);
    expect(createMatchmaking).toHaveBeenCalledWith({ origin });
  });
});

describe('SDK mock receipts', () => {
  it('binds the receipt to prepared mock bytes without invoking any signer or sender during verification', async () => {
    vi.stubEnv('BANKROLL_MOCK', '1');
    const signer = mockPayoutSigner(payee);
    const reference = mockReference({ kind: 'payout' }, new Date(now + 900_000).toISOString());
    const transaction = mockBuiltPayout({ reference, recipients: input.recipients }).transaction;
    const signature = await signer.sendTransaction(transaction);
    const unrelated = await signer.sendTransaction(
      mockBuiltPayout({ reference: 'different' }).transaction,
    );
    const signerSpy = vi.spyOn(signer, 'sendTransaction');
    const { api } = adapter(signer);

    await api.verify({ ...hosted, reference, transaction }, signature);
    expect(confirmPayout).toHaveBeenCalledWith(signature, undefined);
    expect(findPayoutByReference).not.toHaveBeenCalled();
    expect(signerSpy).not.toHaveBeenCalled();
    expect(sendPayout).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    await expect(api.verify({ ...hosted, reference, transaction }, unrelated)).rejects.toThrow(
      'does not match this attempt',
    );
  });

  it('does not use mock receipt acceptance when the flag is disabled', async () => {
    const signer = mockPayoutSigner(payee);
    const reference = mockReference({}, new Date(now + 900_000).toISOString());
    const transaction = mockBuiltPayout({ reference }).transaction;
    const signature = await signer.sendTransaction(transaction);
    await expect(
      adapter(signer).api.verify({ ...hosted, reference, transaction }, signature),
    ).rejects.toMatchObject({ code: 'rpc_error' });
    expect(confirmPayout).not.toHaveBeenCalled();
  });
});
