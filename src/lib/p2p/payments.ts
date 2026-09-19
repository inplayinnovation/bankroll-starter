import type { Json } from '@joinbankroll/sdk/matchmaking';
import { ChargeMismatchError, checkCharge, type PayRecipient } from '@joinbankroll/sdk/server';

import { GameError } from '@/lib/game-error';

import { prepareAttempt, sendInstalled } from './attempt';
import { changeEntry, readEntry, roundPath } from './entries';
import type { Context, PaidRound, Payout } from './types';

/** Money a document owes, before any attempt to pay it. */
export function obligation(recipients: PayRecipient[], memo: string): Payout {
  return { recipients, memo, status: 'pending', attempt: null, signature: null };
}

export function refund<G, C extends Json>(round: PaidRound<G, C>): Payout {
  const { terms } = round.entry;
  return obligation(
    [{ to: round.wallet, amountCents: terms.entryCents, token: terms.mint }],
    `refund:${round.id}`,
  );
}

/**
 * Bankroll reported a transaction carrying the entry's reference. Read it
 * and check it against what the entry was sold for before recording it: a
 * reference is public once it lands, so a transaction carrying it is a
 * candidate, not a receipt. The memo names the entry, so one charge can pay
 * for one entry only.
 */
export async function confirmEntry<G, C extends Json>(
  ctx: Context<G, C>,
  wallet: string,
  id: string,
  signature: string,
): Promise<PaidRound<G, C>> {
  const round = await readEntry(ctx, wallet, id);
  const { payment, terms } = round.entry;
  if (payment.signature) return round;
  let charge;
  try {
    charge = await checkCharge(signature, {
      payer: wallet,
      payee: terms.payee,
      mint: terms.mint,
      amountCents: terms.entryCents,
      memo: payment.memo,
    });
  } catch (error) {
    if (!(error instanceof ChargeMismatchError)) throw error;
    throw new GameError('payment_mismatch', 400, `payment_mismatch: ${error.field}`);
  }
  // A charge landing on a cancelled entry is refunded, in the payout order:
  // the refund's reference minted and bytes built before the write that
  // records the debt, so the debt is never on disk without Bankroll watching
  // an attempt to pay it. Cancellation winning between this read and the
  // write is a retry: the delivery fails, Bankroll delivers again, and the
  // next run prepares the refund.
  const path = roundPath(wallet, id);
  const refundAttempt =
    round.entry.status === 'cancelled' ? await prepareAttempt(ctx, path, round.entry.origin, refund(round)) : null;
  const written = await changeEntry(ctx, wallet, id, (current) => {
    if (current.entry.payment.signature) return current;
    let payout = current.payout;
    if (current.entry.status === 'cancelled') {
      if (!refundAttempt) throw new GameError('try_again', 409);
      payout = { ...refund(current), attempt: refundAttempt };
    }
    return {
      ...current,
      entry: {
        ...current.entry,
        payment: { ...current.entry.payment, signature: charge.signature },
      },
      payout,
    };
  });
  if (refundAttempt) await sendInstalled(ctx, path, written.payout, refundAttempt);
  return written;
}

/** Bankroll stopped watching an entry's reference. Still unpaid, the entry is over. */
export async function expireEntry<G, C extends Json>(
  ctx: Context<G, C>,
  wallet: string,
  id: string,
  reference: string,
): Promise<PaidRound<G, C>> {
  return changeEntry(ctx, wallet, id, (current) => {
    const entry = current.entry;
    if (entry.payment.reference !== reference || entry.payment.signature || entry.status !== 'ready')
      return current;
    return { ...current, entry: { ...entry, status: 'cancelled' } };
  });
}
