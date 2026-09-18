import type { Json } from '@joinbankroll/sdk/matchmaking';
import type { ReferenceWebhookHandlers } from '@joinbankroll/sdk/webhooks';

import { GameError } from '@/lib/game-error';

import { confirmEntry, expireEntry } from './payments';
import { paidOut, settle } from './settle';
import type { Context } from './types';

// What the mode puts in a managed reference's meta, and gets back on every
// event: enough to find the document the reference was minted for.
export type ReferenceMeta =
  | { kind: 'entry'; wallet: string; id: string }
  | { kind: 'payout'; path: string; origin: string };

function referenceMeta(meta: Json): ReferenceMeta | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const { kind, wallet, id, path, origin } = meta;
  if (kind === 'entry' && typeof wallet === 'string' && typeof id === 'string')
    return { kind, wallet, id };
  if (kind === 'payout' && typeof path === 'string' && typeof origin === 'string')
    return { kind, path, origin };
  return null;
}

// A reference Bankroll is done with, for a document this store never had or
// a transaction that is not the entry's payment: retrying would not change
// the answer, so the delivery is acknowledged, not failed.
const settled = (error: unknown) =>
  error instanceof GameError && (error.code === 'game_not_found' || error.code === 'payment_mismatch');

/** The handlers for `referenceWebhook` on /api/bankroll/webhook. */
export function webhookHandlers<G, C extends Json>(ctx: Context<G, C>): ReferenceWebhookHandlers {
  return {
    async onConfirmed(event) {
      const meta = referenceMeta(event.meta);
      if (!meta) return;
      if (meta.kind === 'payout') {
        await paidOut(ctx, meta.path, event.reference, event.signature);
        return;
      }
      try {
        await confirmEntry(ctx, meta.wallet, meta.id, event.signature);
      } catch (error) {
        if (!settled(error)) throw error;
        console.warn(`p2p: reference.confirmed for entry ${meta.id} ignored: ${(error as Error).message}`);
      }
    },
    async onExpired(event) {
      const meta = referenceMeta(event.meta);
      if (!meta) return;
      if (meta.kind === 'payout') {
        // The attempt is dead; settle builds a fresh one for what is still owed.
        await settle(ctx, meta.path, meta.origin);
        return;
      }
      try {
        await expireEntry(ctx, meta.wallet, meta.id, event.reference);
      } catch (error) {
        if (!settled(error)) throw error;
      }
    },
  };
}
