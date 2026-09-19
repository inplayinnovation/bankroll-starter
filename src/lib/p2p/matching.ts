import { isDeepStrictEqual } from 'node:util';

import {
  createMatchmaking,
  MatchmakingError,
  type Json,
  type Ticket,
} from '@joinbankroll/sdk/matchmaking';
import { mockEnabled } from '@joinbankroll/sdk/mock';
import { createManagedReference } from '@joinbankroll/sdk/server';

import { GameError } from '@/lib/game-error';

import { changeEntry, createEntry, readEntry } from './entries';
import { refund } from './payments';
import type { Context, GameHooks, PaidRound } from './types';

export const matchmaking = <C extends Json>(origin: string) => createMatchmaking<C>({ origin });

// The shortest window Bankroll watches a reference for.
const MIN_WINDOW_SECONDS = 60;

// Bankroll is the alarm clock for a no-show. A matched entry mints a
// reference nobody will pay, expiring at its start deadline; Bankroll's
// `reference.expired` then brings the webhook back to settle the forfeit
// when neither player is around to read the round. Both entries in a match
// set one; the second to fire finds the match settled.
async function armDeadline<G, C extends Json>(
  ctx: Context<G, C>,
  round: PaidRound<G, C>,
): Promise<PaidRound<G, C>> {
  const entry = round.entry;
  if (entry.ticket?.state !== 'matched' || entry.deadline !== null) return round;
  const dueInMs = entry.ticket.match.matchedAt + entry.terms.startWindowMs - Date.now();
  const deadline = await createManagedReference(
    {
      meta: { kind: 'deadline', wallet: round.wallet, id: round.id },
      expiresInSeconds: Math.max(MIN_WINDOW_SECONDS, Math.ceil(dueInMs / 1000)),
    },
    { origin: entry.origin },
  );
  return changeEntry(ctx, round.wallet, round.id, (current) =>
    current.entry.deadline === null ? { ...current, entry: { ...current.entry, deadline } } : current,
  );
}

export function acceptedConditions<G, C extends Json>(
  hooks: GameHooks<G, C>,
  ticket: Ticket<C>,
): C {
  if (ticket.state === 'cancelled')
    throw new MatchmakingError('invalid_response', 'A cancelled ticket cannot start a round');
  // The joining player's proposal is NOT its assigned conditions.
  return hooks.conditions.validate(
    ticket.state === 'matched' ? ticket.match.payload : ticket.admission.payload,
  );
}

export async function prepareEntry<G, C extends Json>(
  ctx: Context<G, C>,
  wallet: string,
  origin: string,
  game: G,
  proposal: C,
) {
  // Bankroll reports payments to the webhook; without its secret the route
  // refuses every delivery and no entry could ever be paid. The mock needs none.
  if (!mockEnabled() && !process.env.BANKROLL_WEBHOOK_SECRET)
    throw new GameError('webhooks_not_configured', 503);
  await matchmaking<C>(origin).listTickets({ player: wallet, id: 'setup-check' });
  return createEntry(ctx, wallet, origin, game, proposal);
}

export async function adoptTicket<G, C extends Json>(
  ctx: Context<G, C>,
  wallet: string,
  id: string,
  ticket: Ticket<C>,
) {
  const adopted = await changeEntry(ctx, wallet, id, (round) => {
    const entry = round.entry;
    if (
      ticket.id !== id ||
      (ticket.admission && !isDeepStrictEqual(ticket.admission.input, entry.ticketInput))
    )
      throw new MatchmakingError('invalid_response', 'Ticket does not belong to this entry');
    // Late waiting responses cannot replace a match or resurrect a tombstone.
    if (entry.ticket?.state === 'matched' && ticket.state !== 'matched') return round;
    if (entry.ticket?.state === 'cancelled' && ticket.state !== 'cancelled') return round;
    if (isDeepStrictEqual(entry.ticket, ticket)) return round;
    if (ticket.state === 'cancelled') {
      if (entry.startedAt !== null) throw new GameError('not_refundable', 409);
      return {
        ...round,
        entry: { ...entry, ticket, status: 'cancelled' },
        payout: entry.payment.signature ? refund(round) : null,
      };
    }
    const conditions = acceptedConditions(ctx.hooks, ticket);
    if (ticket.state === 'matched') {
      const entries = ticket.match.tickets;
      if (
        ticket.match.queue !== entry.terms.queue ||
        entries.length !== 2 ||
        new Set(entries.map((item) => item.input.player)).size !== 2 ||
        new Set(entries.map((item) => item.input.id)).size !== 2 ||
        !entries.some((item) => item.input.id === id && item.input.player === wallet) ||
        entries.some((item) => item.input.queue.key !== entry.terms.queue) ||
        (entry.ticket?.state === 'matched' && entry.ticket.match.id !== ticket.match.id)
      )
        throw new MatchmakingError('invalid_response', 'Incompatible match');
    }
    if (entry.startedAt !== null && !isDeepStrictEqual(entry.conditions, conditions))
      throw new MatchmakingError(
        'invalid_response',
        'Accepted conditions cannot change after play',
      );
    return {
      ...round,
      entry: {
        ...entry,
        ticket,
        conditions,
        cancelRequested: ticket.state === 'matched' ? false : entry.cancelRequested,
      },
    };
  });
  return armDeadline(ctx, adopted);
}

export async function syncEntry<G, C extends Json>(
  ctx: Context<G, C>,
  wallet: string,
  id: string,
  origin: string,
) {
  let round = await readEntry(ctx, wallet, id);
  if (round.entry.status === 'cancelled') return round;
  const client = matchmaking<C>(origin);
  if (round.entry.cancelRequested && round.entry.status === 'ready')
    return adoptTicket(ctx, wallet, id, await client.cancelTicket(id));
  if (!round.entry.payment.signature) return round;
  if (!round.entry.ticket) {
    round = await adoptTicket(ctx, wallet, id, await client.createTicket(round.entry.ticketInput));
  } else if (round.entry.ticket.state === 'waiting') {
    const page = await client.listTickets({ id, player: wallet });
    const ticket = page.tickets.find((candidate) => candidate.id === id);
    // Absence never licenses a new proposal, a changed played board, or a refund.
    if (!ticket) throw new GameError('matchmaking_unavailable', 503);
    round = await adoptTicket(ctx, wallet, id, ticket);
  }
  return readEntry(ctx, wallet, round.id);
}

export async function cancelEntry<G, C extends Json>(
  ctx: Context<G, C>,
  wallet: string,
  id: string,
  origin: string,
) {
  const round = await changeEntry(ctx, wallet, id, (current) => {
    const entry = current.entry;
    if (entry.status === 'cancelled') return current;
    if (entry.status !== 'ready' || entry.startedAt !== null)
      throw new GameError('not_refundable', 409);
    if (entry.ticket?.state === 'matched') throw new GameError('already_matched', 409);
    // Unpaid and never queued, there is nothing at Bankroll to cancel: the
    // entry closes here, at once. A charge that lands after all is recorded
    // and refunded by the webhook.
    if (!entry.payment.signature && !entry.ticket)
      return { ...current, entry: { ...entry, status: 'cancelled' } };
    return entry.cancelRequested
      ? current
      : { ...current, entry: { ...entry, cancelRequested: true } };
  });
  if (round.entry.status !== 'cancelled')
    // The SDK arbitrates pairing against cancellation. Only a confirmed
    // tombstone permits the refund; a matched reply instead keeps the stake.
    await adoptTicket(ctx, wallet, id, await matchmaking<C>(origin).cancelTicket(id));
  return syncEntry(ctx, wallet, id, origin);
}
