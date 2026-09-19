import { isDeepStrictEqual } from 'node:util';

import {
  createMatchmaking,
  MatchmakingError,
  type Json,
  type Ticket,
} from '@joinbankroll/sdk/matchmaking';
import { mockEnabled } from '@joinbankroll/sdk/mock';
import { createTimer } from '@joinbankroll/sdk/server';

import { GameError } from '@/lib/game-error';

import { prepareAttempt, sendInstalled } from './attempt';
import { changeEntry, createEntry, readEntry, roundPath } from './entries';
import { refund } from './payments';
import type { Context, GameHooks, PaidRound, PayoutAttempt } from './types';

export const matchmaking = <C extends Json>(origin: string) => createMatchmaking<C>({ origin });

const MS_PER_MINUTE = 60_000;

// Bankroll is the alarm clock for a no-show. A matched entry sets a timer
// for its start deadline; Bankroll's `timer.fired` then brings the webhook
// back to settle the forfeit when neither player is around to read the
// round. Both entries in a match set one; the second to fire finds the
// match settled. Timers fire to the minute, so the deadline rounds up.
async function armDeadline<G, C extends Json>(
  ctx: Context<G, C>,
  round: PaidRound<G, C>,
): Promise<PaidRound<G, C>> {
  const entry = round.entry;
  if (entry.ticket?.state !== 'matched' || entry.deadline !== null) return round;
  const dueInMs = entry.ticket.match.matchedAt + entry.terms.startWindowMs - Date.now();
  const deadline = await createTimer(
    {
      meta: { kind: 'deadline', wallet: round.wallet, id: round.id },
      firesInMinutes: Math.max(1, Math.ceil(dueInMs / MS_PER_MINUTE)),
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

// A paid entry's refund follows the payout order: reference, write, send. It
// is prepared before the tombstone is written, so a cancelled paid entry is
// never on disk without Bankroll watching its refund; if Bankroll cannot
// mint, the cancel fails and nothing is written. An entry still unpaid, or
// already cancelled, needs none.
async function prepareRefund<G, C extends Json>(
  ctx: Context<G, C>,
  wallet: string,
  id: string,
): Promise<PayoutAttempt | null> {
  const round = await readEntry(ctx, wallet, id);
  if (!round.entry.payment.signature || round.entry.status === 'cancelled') return null;
  return prepareAttempt(ctx, roundPath(wallet, id), round.entry.origin, refund(round));
}

export async function adoptTicket<G, C extends Json>(
  ctx: Context<G, C>,
  wallet: string,
  id: string,
  ticket: Ticket<C>,
) {
  const refundAttempt = ticket.state === 'cancelled' ? await prepareRefund(ctx, wallet, id) : null;
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
      // A charge that landed since the refund was (not) prepared: cancel
      // again, with the refund prepared, rather than write a debt without one.
      if (entry.payment.signature && !refundAttempt) throw new GameError('try_again', 409);
      return {
        ...round,
        entry: { ...entry, ticket, status: 'cancelled' },
        payout: entry.payment.signature ? { ...refund(round), attempt: refundAttempt } : null,
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
  if (refundAttempt) await sendInstalled(ctx, roundPath(wallet, id), adopted.payout, refundAttempt);
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
