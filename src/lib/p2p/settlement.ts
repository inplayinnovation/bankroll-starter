import type { Json, Match } from '@joinbankroll/sdk/matchmaking';
import { MOCK_OPPONENT, mockEnabled } from '@joinbankroll/sdk/mock';
import type { PayRecipient } from '@joinbankroll/sdk/server';

import { GameError } from '@/lib/game-error';

import { finalRound, isGameId, readEntry } from './entries';
import { adoptTicket } from './matching';
import { obligation } from './payments';
import type { Context, FinalRound, MatchResult, PaidRound } from './types';

export const matchPath = (id: string) => `matches/${encodeURIComponent(id)}.json`;

async function terminalPlayer<G, C extends Json>(
  ctx: Context<G, C>,
  match: Match<C>,
  id: string,
  startWindowMs: number,
) {
  const admission = match.tickets.find((entry) => entry.input.id === id)!;
  const wallet = admission.input.player;
  // The SDK development stand-in has no game/charge; it forfeits at the same
  // deadline. This path and its exclusion from recipients are off in production.
  if (mockEnabled() && wallet === MOCK_OPPONENT)
    return Date.now() >= match.matchedAt + startWindowMs
      ? { id, wallet, game: null, reason: 'forfeited' as const }
      : null;
  if (!isGameId(id)) throw new GameError('invalid_match', 503);
  await adoptTicket(ctx, wallet, id, { id, state: 'matched', admission, match });
  const round = await readEntry(ctx, wallet, id);
  if (!round.entry.payment.signature) throw new GameError('invalid_match', 503);
  return finalRound(ctx, round);
}

/** Terminal snapshots are the inputs; one atomic create fixes the obligation. */
export async function resolveMatch<G, C extends Json>(
  ctx: Context<G, C>,
  round: PaidRound<G, C>,
): Promise<MatchResult<G> | null> {
  if (round.entry.ticket?.state !== 'matched') return null;
  const { match } = round.entry.ticket;
  const { terms } = round.entry;
  const path = matchPath(match.id);
  let stored = await ctx.store.readJson<MatchResult<G>>(path);
  if (!stored) {
    const finals = await Promise.all(
      match.tickets.map((ticket) =>
        terminalPlayer(ctx, match, ticket.input.id, terms.startWindowMs),
      ),
    );
    if (!finals[0] || !finals[1]) return null;
    const players: [FinalRound<G>, FinalRound<G>] = [finals[0], finals[1]];
    const outcome = ctx.hooks.outcome(players[0], players[1]);
    if (
      (outcome.kind === 'tie' && outcome.winner !== null) ||
      (outcome.kind !== 'tie' && !players.some((player) => player.id === outcome.winner))
    )
      throw new GameError('invalid_outcome', 503);
    const winner = outcome.winner;
    const recipients: PayRecipient[] = players
      .filter((player) => !(mockEnabled() && player.wallet === MOCK_OPPONENT))
      .map((player) => ({
        to: player.wallet,
        token: terms.mint,
        amountCents:
          winner === null ? terms.entryCents : player.id === winner ? terms.prizeCents : 0,
      }));
    if (terms.creatorWallet !== terms.payee)
      recipients.push({
        to: terms.creatorWallet,
        token: terms.mint,
        amountCents: winner === null ? 0 : terms.creatorFeeCents,
      });
    await ctx.store.createIfAbsent(path, {
      id: match.id,
      origin: round.entry.origin,
      players,
      outcome,
      winner,
      entryCents: terms.entryCents,
      prizeCents: terms.prizeCents,
      creatorFeeCents: winner === null ? 0 : terms.creatorFeeCents,
      payout: obligation(recipients, `duel:${match.id}`),
    } satisfies MatchResult<G>);
  }
  stored = await ctx.store.readJson<MatchResult<G>>(path);
  return stored!.value;
}
