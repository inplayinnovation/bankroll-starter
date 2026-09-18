import type { Json } from '@joinbankroll/sdk/matchmaking';
import { ChargeMismatchError, checkCharge, type PayRecipient } from '@joinbankroll/sdk/server';

import { GameError } from '@/lib/game-error';

import { changeEntry, readEntry } from './entries';
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
  // Cancellation may have won while the charge was checked; record its
  // refund in this same CAS, and the transition pays it.
  return changeEntry(ctx, wallet, id, (current) => {
    if (current.entry.payment.signature) return current;
    return {
      ...current,
      entry: {
        ...current.entry,
        payment: { ...current.entry.payment, signature: charge.signature },
      },
      payout: current.entry.status === 'cancelled' ? refund(current) : current.payout,
    };
  });
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
