import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  ComputeBudgetProgram,
  Connection,
  Transaction,
  TransactionMessage,
  type TransactionInstruction,
} from '@solana/web3.js';

import { createMatchmaking, type Json, type Matchmaking } from '@joinbankroll/sdk/matchmaking';
import { isMockPayoutSignature, mockEnabled, mockPayoutReference } from '@joinbankroll/sdk/mock';
import {
  buildAndSignPayout,
  buildPayout,
  checkCharge,
  confirmPayout,
  createManagedReference,
  createTimer,
  findPayoutByReference,
  PayError,
  rpcUrl,
  sendPayout,
  type ConfirmedCharge,
  type ExpectedCharge,
  type ManagedReference,
  type PaymentSigner,
  type PayRecipient,
  type Timer,
} from '@joinbankroll/sdk/server';

export interface PreparedPayout {
  id: string;
  reference: string;
  transaction: string;
  signature: string | null;
  lastValidBlockHeight: number | null;
  mode: 'signed' | 'hosted';
}

export type PayoutEvidence =
  { status: 'paid'; signature: string } | { status: 'retryable' } | { status: 'unresolved' };

/** A terminal reference observation did not prove the prepared payout happened. */
export class PayoutReceiptMismatch extends Error {
  constructor(message = 'Payout receipt does not match the prepared transaction') {
    super(message);
    this.name = 'PayoutReceiptMismatch';
  }
}

export interface BankrollPrimitives {
  reference(input: {
    origin: string;
    meta: Record<string, Json>;
    expiresInSeconds?: number;
  }): Promise<ManagedReference>;
  timer(input: { origin: string; meta: Record<string, Json>; dueAt: number }): Promise<Timer>;
  matchmaking(origin: string): Matchmaking<Json>;
  charge(signature: string, expected: ExpectedCharge): Promise<ConfirmedCharge>;
  prepare(input: {
    id: string;
    reference: string;
    payee: string;
    recipients: PayRecipient[];
    memo: string;
  }): Promise<PreparedPayout>;
  /** The engine must durably claim a hosted attempt before its single send. */
  send(attempt: PreparedPayout, payee: string): Promise<string>;
  /** Transient failures throw so the originating webhook remains retryable. */
  reconcile(attempt: PreparedPayout): Promise<PayoutEvidence>;
  /** Unknown hosted signatures also require matching all prepared payout instructions. */
  verify(attempt: PreparedPayout, signature: string): Promise<void>;
}

function payoutInstructions(instructions: TransactionInstruction[]) {
  return instructions
    .filter((instruction) => !instruction.programId.equals(ComputeBudgetProgram.programId))
    .map((instruction) => ({
      program: instruction.programId.toBase58(),
      data: instruction.data.toString('base64'),
      keys: instruction.keys.map((key) => ({
        address: key.pubkey.toBase58(),
        signer: key.isSigner,
        writable: key.isWritable,
      })),
    }));
}

async function hostedReceiptMatches(attempt: PreparedPayout, signature: string): Promise<boolean> {
  const prepared = Transaction.from(Buffer.from(attempt.transaction, 'base64'));
  let receipt;
  try {
    receipt = await new Connection(rpcUrl(), 'confirmed').getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
  } catch (cause) {
    throw new PayError('rpc_error', 'Failed to inspect hosted payout receipt', { cause });
  }
  if (!receipt || !receipt.meta)
    throw new PayError('rpc_error', 'Confirmed hosted payout receipt is not available yet');
  if (receipt.meta.err !== null || receipt.transaction.signatures[0] !== signature) return false;
  const landed = TransactionMessage.decompile(
    receipt.transaction.message,
    receipt.meta.loadedAddresses
      ? { accountKeysFromLookups: receipt.meta.loadedAddresses }
      : undefined,
  );
  // Hosting may refresh the blockhash, sponsor the network fee, or tune compute
  // limits. All payout instructions, account roles, amounts and mints must stay
  // identical. Other provider rewrites conservatively require operator review.
  return isDeepStrictEqual(
    payoutInstructions(prepared.instructions),
    payoutInstructions(landed.instructions),
  );
}

function signedIdentity(attempt: PreparedPayout) {
  if (
    !attempt.signature ||
    attempt.lastValidBlockHeight === null ||
    !Number.isSafeInteger(attempt.lastValidBlockHeight) ||
    attempt.lastValidBlockHeight < 0
  )
    throw new Error('A signed payout requires its signature and last valid block height');
  return { signature: attempt.signature, lastValidBlockHeight: attempt.lastValidBlockHeight };
}

/** SDK primitives plus complete hosted receipt inspection; persistence stays in the engine. */
export function createBankrollPrimitives(options: {
  payoutSigner: (attemptId: string) => PaymentSigner;
  now?: () => number;
}): BankrollPrimitives {
  const now = options.now ?? (() => Date.now());
  const signerFor = (id: string, payee: string) => {
    const signer = options.payoutSigner(id);
    if (signer.address !== payee)
      throw new Error('Payout signer does not match the recorded treasury');
    return signer;
  };

  return {
    reference({ origin, meta, expiresInSeconds }) {
      return createManagedReference(
        { meta, ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }) },
        { origin },
      );
    },

    timer({ origin, meta, dueAt }) {
      const firesInMinutes = Math.max(1, Math.ceil((dueAt - now()) / 60_000));
      if (!Number.isFinite(dueAt) || !Number.isFinite(firesInMinutes) || firesInMinutes > 43_200)
        throw new Error('Timer deadline must be finite and within the SDK scheduling window');
      return createTimer({ meta, firesInMinutes }, { origin });
    },

    matchmaking(origin) {
      return createMatchmaking<Json>({ origin });
    },

    charge(signature, expected) {
      return checkCharge(signature, expected);
    },

    async prepare({ id, reference, payee, recipients, memo }) {
      const signer = signerFor(id, payee);
      const input = { reference, recipients, memo };
      if (signer.signTransaction) {
        const built = await buildAndSignPayout(input, { signer });
        return {
          id,
          reference,
          transaction: built.transaction,
          signature: built.signature,
          lastValidBlockHeight: built.lastValidBlockHeight,
          mode: 'signed',
        };
      }
      const built = await buildPayout(input, { signer });
      // The provider can rebuild the transaction. This unsigned build's height
      // is not evidence that the eventual hosted transaction has expired.
      return {
        id,
        reference,
        transaction: built.transaction,
        signature: null,
        lastValidBlockHeight: null,
        mode: 'hosted',
      };
    },

    async send(attempt, payee) {
      const signer = signerFor(attempt.id, payee);
      if ((attempt.mode === 'signed') !== Boolean(signer.signTransaction))
        throw new Error('Payout signer capabilities changed after the attempt was prepared');
      if (attempt.mode === 'signed') signedIdentity(attempt);
      else if (attempt.signature !== null)
        throw new Error('A submitted hosted payout must be reconciled, not resent');
      const sent = await sendPayout(attempt.transaction, { signer });
      if (attempt.mode === 'signed' && sent.signature !== attempt.signature)
        throw new Error('Payout signer returned a different transaction signature');
      return sent.signature;
    },

    async reconcile(attempt) {
      const identity = attempt.mode === 'signed' ? signedIdentity(attempt) : null;
      try {
        let signature = attempt.signature;
        if (signature === null) {
          const found = await findPayoutByReference(attempt.reference);
          if (!found || found.failed) return { status: 'unresolved' };
          signature = found.signature;
        }
        await confirmPayout(
          signature,
          identity ? { lastValidBlockHeight: identity.lastValidBlockHeight } : undefined,
        );
        if (attempt.signature === null && !(await hostedReceiptMatches(attempt, signature)))
          return { status: 'unresolved' };
        return { status: 'paid', signature };
      } catch (error) {
        if (
          error instanceof PayError &&
          (error.code === 'failed_on_chain' || error.code === 'expired')
        )
          return { status: attempt.mode === 'signed' ? 'retryable' : 'unresolved' };
        // A failed query or confirmation timeout is not a permanent ambiguity:
        // keep the webhook delivery alive rather than acknowledging a stuck debt.
        throw error;
      }
    },

    async verify(attempt, signature) {
      const identity = attempt.mode === 'signed' ? signedIdentity(attempt) : null;
      let inspectHosted = false;
      if (attempt.signature !== null) {
        if (signature !== attempt.signature)
          throw new PayoutReceiptMismatch(
            'Payout receipt does not match the recorded transaction signature',
          );
      } else if (
        mockEnabled() &&
        isMockPayoutSignature(signature) &&
        mockPayoutReference(attempt.transaction) === attempt.reference
      ) {
        // SDK 0.29's mock receipt hashes these bytes. Verification must never
        // invoke the SDK send wrapper, which also delivers a mock webhook.
        const expected = `mock-payout-${createHash('sha256').update(attempt.transaction).digest('hex').slice(0, 32)}`;
        if (signature !== expected)
          throw new PayoutReceiptMismatch('Mock payout receipt does not match this attempt');
      } else {
        const found = await findPayoutByReference(attempt.reference);
        if (!found)
          throw new PayError(
            'rpc_error',
            'Confirmed payout reference history is not available yet',
          );
        if (found.failed || found.signature !== signature)
          throw new PayoutReceiptMismatch(
            'Payout receipt does not match a successful transaction at its reference',
          );
        inspectHosted = true;
      }
      await confirmPayout(
        signature,
        identity ? { lastValidBlockHeight: identity.lastValidBlockHeight } : undefined,
      );
      if (inspectHosted && !(await hostedReceiptMatches(attempt, signature)))
        throw new PayoutReceiptMismatch();
    },
  };
}
