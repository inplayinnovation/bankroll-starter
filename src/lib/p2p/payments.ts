import type { Json } from '@joinbankroll/sdk/matchmaking';
import { claimCharge, pendingPayout, ReceiptError } from '@joinbankroll/sdk/server';

import { GameError } from '@/lib/game-error';

import { changeEntry, readEntry, roundPath } from './entries';
import type { Context, PaidRound } from './types';

export function refund<G, C extends Json>(round: PaidRound<G, C>) {
  const { terms } = round.entry;
  return pendingPayout(
    terms.payee,
    [{ to: round.wallet, amountCents: terms.entryCents, token: terms.mint }],
    `refund:${round.id}`,
  );
}

export async function confirmEntry<G, C extends Json>(
  ctx: Context<G, C>,
  wallet: string,
  id: string,
  signature?: string,
): Promise<PaidRound<G, C>> {
  const round = await readEntry(ctx, wallet, id);
  const { payment, terms } = round.entry;
  if (payment.signature) return round;
  const claimed = await claimCharge({
    store: ctx.store,
    entry: roundPath(wallet, id),
    reference: payment.reference,
    signature,
    expected: {
      payer: wallet,
      payee: terms.payee,
      mint: terms.mint,
      amountCents: terms.entryCents,
      memo: payment.memo,
    },
  }).catch((error: unknown) => {
    if (!(error instanceof ReceiptError)) throw error;
    throw new GameError(
      error.code,
      error.code === 'payment_already_used' ? 409 : 400,
      error.field ? `${error.code}: ${error.field}` : error.code,
    );
  });
  if (!claimed) return round;
  // created=false still repairs an interrupted write. Cancellation may have
  // won while the SDK confirmed the charge; record its refund in this same CAS.
  return changeEntry(ctx, wallet, id, (current) => {
    if (current.entry.payment.signature) return current;
    return {
      ...current,
      entry: {
        ...current.entry,
        payment: { ...current.entry.payment, signature: claimed.charge.signature },
      },
      payout: current.entry.status === 'cancelled' ? refund(current) : current.payout,
    };
  });
}
