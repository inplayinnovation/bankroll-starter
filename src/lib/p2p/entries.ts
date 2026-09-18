import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { Json } from '@joinbankroll/sdk/matchmaking';
import { createReference } from '@joinbankroll/sdk/server';
import { PreconditionFailed, sortableId, TooContended } from '@joinbankroll/sdk/store';

import { GameError } from '@/lib/game-error';

import { indexEntry } from './entry-index';
import { entryTerms } from './terms';
import type { Context, Entry, FinalRound, PaidRound, Round } from './types';

const ID_PATTERN = /^\d{16}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isGameId = (id: string) => ID_PATTERN.test(id);
export const roundPrefix = (wallet: string) => `games/${encodeURIComponent(wallet)}/`;
export function roundPath(wallet: string, id: string) {
  if (!isGameId(id)) throw new GameError('game_not_found', 404);
  return `${roundPrefix(wallet)}${id}.json`;
}

export function supported<Game, Conditions extends Json>(
  ctx: Context<Game, Conditions>,
  round: Round<Game, Conditions>,
) {
  return (
    round.schema === 1 &&
    round.kind === ctx.hooks.conditions.key &&
    round.game !== undefined &&
    round.entry !== undefined
  );
}

function refresh<Game, Conditions extends Json>(
  ctx: Context<Game, Conditions>,
  round: Round<Game, Conditions>,
) {
  const now = Date.now();
  const entry = round.entry;
  if (entry?.status === 'ready' && entry.ticket?.state === 'matched') {
    const forfeitedAt = entry.ticket.match.matchedAt + entry.terms.startWindowMs;
    if (now >= forfeitedAt)
      return { ...round, entry: { ...entry, status: 'forfeited' as const, forfeitedAt } };
  }
  if (entry?.status === 'cancelled' || entry?.status === 'forfeited') return round;
  const terminal = ctx.hooks.terminal(round.game, now);
  return terminal && !isDeepStrictEqual(terminal.game, round.game)
    ? { ...round, game: terminal.game }
    : round;
}

/** Both sections, clock expiry, and replay checks compete on this one key. */
export async function changeRound<Game, Conditions extends Json>(
  ctx: Context<Game, Conditions>,
  wallet: string,
  id: string,
  change: (round: Round<Game, Conditions>) => Round<Game, Conditions>,
): Promise<Round<Game, Conditions>> {
  const path = roundPath(wallet, id);
  for (let attempt = 0; attempt < 5; attempt++) {
    const stored = await ctx.store.readJson<Round<Game, Conditions>>(path);
    if (
      !stored ||
      !supported(ctx, stored.value) ||
      stored.value.wallet !== wallet ||
      stored.value.id !== id
    )
      throw new GameError('game_not_found', 404);
    // Re-evaluate expiry inside every retry, never carry a stale play decision.
    const next = change(refresh(ctx, stored.value));
    if ((next.entry === null) !== (stored.value.entry === null))
      throw new GameError('invalid_mode', 409);
    if (
      next.id !== id ||
      next.wallet !== wallet ||
      next.kind !== stored.value.kind ||
      next.schema !== 1
    )
      throw new GameError('invalid_round', 409);
    if (next === stored.value) return next;
    try {
      await ctx.store.writeJson(path, next, stored.etag);
      return next;
    } catch (error) {
      if (!(error instanceof PreconditionFailed)) throw error;
    }
  }
  throw new TooContended(path, 5);
}

export const readRound = <G, C extends Json>(ctx: Context<G, C>, wallet: string, id: string) =>
  changeRound(ctx, wallet, id, (round) => round);

export function paidRound<G, C extends Json>(round: Round<G, C>): PaidRound<G, C> {
  if (!round.entry) throw new GameError('paid_entry_required', 409);
  return round as PaidRound<G, C>;
}
export const readEntry = async <G, C extends Json>(
  ctx: Context<G, C>,
  wallet: string,
  id: string,
) => paidRound(await readRound(ctx, wallet, id));
export const changeEntry = async <G, C extends Json>(
  ctx: Context<G, C>,
  wallet: string,
  id: string,
  change: (round: PaidRound<G, C>) => PaidRound<G, C>,
) => paidRound(await changeRound(ctx, wallet, id, (round) => change(paidRound(round))));

export async function createEntry<Game, Conditions extends Json>(
  ctx: Context<Game, Conditions>,
  wallet: string,
  game: Game,
  proposal: Conditions,
  origin?: string,
): Promise<PaidRound<Game, Conditions>> {
  const createdAt = Date.now();
  const id = sortableId(createdAt, randomUUID());
  const conditions = ctx.hooks.conditions.validate(proposal);
  const terms = entryTerms(ctx.hooks.conditions.key, ctx.policy, ctx.paymentTerms());
  const round: PaidRound<Game, Conditions> = {
    schema: 1,
    kind: ctx.hooks.conditions.key,
    id,
    wallet,
    createdAt,
    game,
    payout: null,
    entry: {
      status: 'ready',
      startedAt: null,
      forfeitedAt: null,
      origin,
      terms,
      conditions,
      payment: {
        reference: createReference(),
        key: randomUUID(),
        memo: `entry:${id}`,
        offeredUntil: createdAt + 5 * 60_000,
        signature: null,
      },
      // Never substitute accepted conditions into this original retry input.
      // No expiry: a played ticket stays matchable and cannot turn into a refund.
      ticketInput: {
        id,
        player: wallet,
        queue: { key: terms.queue, size: 2 },
        payload: conditions,
      },
      ticket: null,
      cancelRequested: false,
    },
  };
  await indexEntry(ctx.store, wallet, id);
  if (!(await ctx.store.createIfAbsent(roundPath(wallet, id), round)))
    throw new GameError('try_again', 409);
  return round;
}

/** Call inside the game's start CAS, alongside its first revealed play state. */
export function startEntry<C extends Json>(entry: Entry<C>, now: number): Entry<C> {
  if (entry.status !== 'ready') throw new GameError('not_startable', 409);
  if (entry.cancelRequested) throw new GameError('cancellation_pending', 409);
  if (!entry.payment.signature) throw new GameError('payment_required', 409);
  if (!entry.ticket || entry.ticket.state === 'cancelled') throw new GameError('not_admitted', 409);
  return { ...entry, status: 'started', startedAt: now };
}

export function finalRound<G, C extends Json>(
  ctx: Context<G, C>,
  round: PaidRound<G, C>,
): FinalRound<G> | null {
  const terminal =
    round.entry.status === 'forfeited'
      ? { game: round.game, reason: 'forfeited' as const }
      : round.entry.status === 'started'
        ? ctx.hooks.terminal(round.game, Date.now())
        : null;
  // Time can cross a deadline AFTER readRound's CAS. Do not settle from an
  // unpersisted expiry: another word may have won a write before that deadline.
  // The next read persists the terminal snapshot against the current etag.
  return terminal && isDeepStrictEqual(terminal.game, round.game)
    ? { id: round.id, wallet: round.wallet, ...terminal }
    : null;
}
