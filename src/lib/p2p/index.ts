import type { Json, Ticket } from '@joinbankroll/sdk/matchmaking';

import * as entries from './entries';
import * as matching from './matching';
import { confirmEntry } from './payments';
import { reconcileEntry } from './reconcile';
import { DEFAULT_POLICY, type Policy } from './rules';
import { resolveMatch } from './settlement';
import type { Context, PaidRound, Round } from './types';
import { runReconciliation } from './worker';

/** Bind infrastructure and three game hooks once, at the recipe boundary. */
export function createP2P<G, C extends Json>(
  options: Omit<Context<G, C>, 'policy'> & { policy?: Partial<Policy> },
) {
  const ctx: Context<G, C> = { ...options, policy: { ...DEFAULT_POLICY, ...options.policy } };
  const reconcile = (wallet: string, id: string, origin: string) =>
    reconcileEntry(ctx, wallet, id, origin);
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
    resolveMatch: (round: PaidRound<G, C>) => resolveMatch(ctx, round),
    reconcileEntry: reconcile,
    runReconciliation: (origin: string) => runReconciliation(ctx.store, reconcile, origin),
  };
}
