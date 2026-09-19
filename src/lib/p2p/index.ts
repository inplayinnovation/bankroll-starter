import type { Json, Ticket } from '@joinbankroll/sdk/matchmaking';

import * as entries from './entries';
import * as matching from './matching';
import { DEFAULT_POLICY, type Policy } from './rules';
import { settleRound } from './settle';
import type { Context, PaidRound, Round } from './types';
import { webhookHandlers } from './webhook';

/**
 * Bind infrastructure and three game hooks once, at the recipe boundary.
 *
 * What comes back is the player surface a request handler calls: read and
 * change rounds, prepare an entry, sync or cancel its ticket. Payments never
 * come from a request: Bankroll watches the chain for every reference the
 * mode mints and reports to `webhook`, the handlers for the app's
 * /api/bankroll/webhook route, which is what pays an entry in. Money moves
 * out without a worker: a transition or a read that leaves a round owing pays
 * it before the request answers, and the webhook reports the landing.
 */
export function createP2P<G, C extends Json>(
  options: Omit<Context<G, C>, 'policy' | 'settle'> & { policy?: Partial<Policy> },
) {
  // Settling runs without the trigger, so paying a round never triggers
  // paying it again: the player side is the only side that triggers.
  const settling: Context<G, C> = {
    ...options,
    policy: { ...DEFAULT_POLICY, ...options.policy },
    settle: undefined,
  };
  const ctx: Context<G, C> = {
    ...settling,
    settle: (wallet, id) => settleRound(settling, wallet, id),
  };
  return {
    readRound: (wallet: string, id: string) => entries.readRound(ctx, wallet, id),
    changeRound: (wallet: string, id: string, change: (round: Round<G, C>) => Round<G, C>) =>
      entries.changeRound(ctx, wallet, id, change),
    supported: (round: Round<G, C>) => entries.supported(ctx, round),
    createEntry: (wallet: string, origin: string, game: G, proposal: C) =>
      entries.createEntry(ctx, wallet, origin, game, proposal),
    prepareEntry: (wallet: string, origin: string, game: G, proposal: C) =>
      matching.prepareEntry(ctx, wallet, origin, game, proposal),
    readEntry: (wallet: string, id: string) => entries.readEntry(ctx, wallet, id),
    changeEntry: (
      wallet: string,
      id: string,
      change: (round: PaidRound<G, C>) => PaidRound<G, C>,
    ) => entries.changeEntry(ctx, wallet, id, change),
    adoptTicket: (wallet: string, id: string, ticket: Ticket<C>) =>
      matching.adoptTicket(ctx, wallet, id, ticket),
    syncEntry: (wallet: string, id: string, origin: string) =>
      matching.syncEntry(ctx, wallet, id, origin),
    cancelEntry: (wallet: string, id: string, origin: string) =>
      matching.cancelEntry(ctx, wallet, id, origin),
    webhook: webhookHandlers(ctx),
  };
}
