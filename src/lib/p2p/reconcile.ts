import type { Json } from '@joinbankroll/sdk/matchmaking';
import { settlePayout } from '@joinbankroll/sdk/server';

import { finalRound, readEntry, roundPath } from './entries';
import { syncEntry } from './matching';
import { matchPath, resolveMatch } from './settlement';
import type { Context, MatchResult } from './types';

/** No session or client needed. Never starts a round or reveals its play state. */
export async function reconcileEntry<G, C extends Json>(
  ctx: Context<G, C>,
  wallet: string,
  id: string,
  fallbackOrigin: string,
) {
  let round = await readEntry(ctx, wallet, id);
  if (round.entry.status === 'cancelled' && round.payout?.status === 'paid') return;
  const payoutOptions = { store: ctx.store, signer: ctx.signer };
  if (round.entry.ticket?.state === 'matched') {
    const path = matchPath(round.entry.ticket.match.id);
    if (await ctx.store.readJson<MatchResult<G>>(path)) {
      // Stored obligations survive a matchmaking outage.
      await settlePayout(path, payoutOptions);
      return;
    }
  }
  // Reference recovery, admission/cancellation retries, and terminal expiry.
  // An old quote is not proof of nonpayment.
  round = await syncEntry(ctx, wallet, id, round.entry.origin ?? fallbackOrigin);
  if (round.entry.status === 'cancelled') {
    await settlePayout(roundPath(wallet, id), payoutOptions);
  } else if (finalRound(ctx, round)) {
    const match = await resolveMatch(ctx, round);
    if (match) await settlePayout(matchPath(match.id), payoutOptions);
  }
}
