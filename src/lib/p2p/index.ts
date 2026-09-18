import type { Json, Ticket } from '@joinbankroll/sdk/matchmaking';

import * as entries from './entries';
import * as matching from './matching';
import { confirmEntry } from './payments';
import { reconcileEntry } from './reconcile';
import { DEFAULT_POLICY, type Policy } from './rules';
import { resolveMatch } from './settlement';
import type { Context, PaidRound, Round } from './types';
import { runReconciliation } from './worker';

/**
 * Bind infrastructure and three game hooks once, at the recipe boundary.
 *
 * What comes back has two sides. The player surface is what a request
 * handler calls: read and change rounds, prepare and confirm an entry, sync
 * or cancel its ticket. `worker` is the scheduled side: it records match
 * results and advances payouts and refunds, and only the cron route calls
 * it. A player request never executes a payout.
 */
export function createP2P<G, C extends Json>(
  options: Omit<Context<G, C>, 'policy' | 'settleLater'> & { policy?: Partial<Policy> },
) {
  // The worker runs without the kick, so settling a round never schedules
  // another settlement of it: the player side is the only side that kicks.
  const worker: Context<G, C> = {
    ...options,
    policy: { ...DEFAULT_POLICY, ...options.policy },
    settleLater: undefined,
  };
  const reconcile = (wallet: string, id: string, origin: string) =>
    reconcileEntry(worker, wallet, id, origin);
  const { after } = options;
  const ctx: Context<G, C> = {
    ...worker,
    settleLater: after
      ? (wallet, id, origin) =>
          after(() =>
            reconcile(wallet, id, origin).catch((error: unknown) => {
              // The scheduled worker takes the round on its next pass.
              console.error(`p2p: background settlement of ${id} failed; the worker retries it`, error);
            }),
          )
      : undefined,
  };
  return {
    readRound: (wallet: string, id: string) => entries.readRound(ctx, wallet, id),
    changeRound: (wallet: string, id: string, change: (round: Round<G, C>) => Round<G, C>) =>
      entries.changeRound(ctx, wallet, id, change),
    supported: (round: Round<G, C>) => entries.supported(ctx, round),
    createEntry: (wallet: string, game: G, proposal: C, origin?: string) =>
      entries.createEntry(ctx, wallet, game, proposal, origin),
    prepareEntry: (wallet: string, origin: string, game: G, proposal: C) =>
      matching.prepareEntry(ctx, wallet, origin, game, proposal),
    readEntry: (wallet: string, id: string) => entries.readEntry(ctx, wallet, id),
    changeEntry: (
      wallet: string,
      id: string,
      change: (round: PaidRound<G, C>) => PaidRound<G, C>,
    ) => entries.changeEntry(ctx, wallet, id, change),
    confirmEntry: (wallet: string, id: string, signature?: string) =>
      confirmEntry(ctx, wallet, id, signature),
    adoptTicket: (wallet: string, id: string, ticket: Ticket<C>) =>
      matching.adoptTicket(ctx, wallet, id, ticket),
    syncEntry: (wallet: string, id: string, origin: string) =>
      matching.syncEntry(ctx, wallet, id, origin),
    cancelEntry: (wallet: string, id: string, origin: string) =>
      matching.cancelEntry(ctx, wallet, id, origin),
    worker: {
      runReconciliation: (origin: string) => runReconciliation(worker.store, reconcile, origin),
      reconcileEntry: reconcile,
      resolveMatch: (round: PaidRound<G, C>) => resolveMatch(worker, round),
    },
  };
}
