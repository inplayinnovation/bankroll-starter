import { randomUUID } from 'node:crypto';

import type { Json } from '@joinbankroll/sdk/matchmaking';
import {
  buildPayout,
  createManagedReference,
  sendPayout,
  type PaymentSigner,
} from '@joinbankroll/sdk/server';
import { updateJson } from '@joinbankroll/sdk/store';

import type { Context, Payout, PayoutAttempt } from './types';

// One attempt to pay what a document owes, in the order that makes a lost
// step safe: a managed reference from Bankroll, the bytes built with it, both
// written on the owing document, and only then the send. Bankroll watches
// the reference for the whole window, so whatever happens after the write,
// `reference.confirmed` or `reference.expired` reaches the webhook.

// A keypair's transaction dies with its blockhash, a minute or two after the
// build, with room here for a stalled chain; a Privy signer replays the same
// idempotency key for a day and declares that window. Bankroll watches for
// the whole window and reports expiry only after it, which is what makes a
// fresh transaction safe.
const KEYPAIR_WINDOW_SECONDS = 15 * 60;

export interface Owing {
  payout: Payout | null;
}

const windowFor = (signer: PaymentSigner) =>
  signer.replayWindowMs ? Math.ceil(signer.replayWindowMs / 1000) : KEYPAIR_WINDOW_SECONDS;

/** Reference minted and bytes built; nothing written, nothing sent. */
export async function prepareAttempt<G, C extends Json>(
  ctx: Context<G, C>,
  path: string,
  origin: string,
  payout: Payout,
): Promise<PayoutAttempt> {
  const idempotencyKey = randomUUID();
  const signer = ctx.payoutSigner(idempotencyKey);
  const { reference, expiresAt } = await createManagedReference(
    { meta: { kind: 'payout', path, origin }, expiresInSeconds: windowFor(signer) },
    { origin },
  );
  const built = await buildPayout({ recipients: payout.recipients, memo: payout.memo, reference }, { signer });
  return { reference, expiresAt, idempotencyKey, transaction: built.transaction, signature: null };
}

/**
 * Send the attempt a write just installed on `path`, when that write was
 * ours: the install decides every race, so an attempt another caller
 * installed is theirs to send. A failed send is logged, not thrown: the
 * attempt is on the document and Bankroll's expiry of it is the retry.
 */
export async function sendInstalled<G, C extends Json>(
  ctx: Context<G, C>,
  path: string,
  installed: Payout | null,
  attempt: PayoutAttempt,
): Promise<Payout | null> {
  if (installed?.attempt?.idempotencyKey !== attempt.idempotencyKey) return installed;
  const signer = ctx.payoutSigner(attempt.idempotencyKey);
  let signature: string;
  try {
    ({ signature } = await sendPayout(attempt.transaction, { signer }));
  } catch (error) {
    console.error(`p2p: sending the payout for ${path} failed; Bankroll's expiry of the attempt retries it`, error);
    return installed;
  }
  const sent = await updateJson<Owing>(ctx.store, path, (current) =>
    current.payout?.attempt?.idempotencyKey === attempt.idempotencyKey && current.payout.status !== 'paid'
      ? {
          ...current,
          payout: {
            ...current.payout,
            status: 'sent',
            attempt: { ...current.payout.attempt, signature },
          },
        }
      : current,
  );
  return sent.payout;
}
