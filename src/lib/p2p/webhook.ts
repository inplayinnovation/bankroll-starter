import type { Json } from '@joinbankroll/sdk/matchmaking';
import type { BankrollWebhookHandlers } from '@joinbankroll/sdk/webhooks';

import { GameError } from '@/lib/game-error';

import { confirmEntry, expireEntry } from './payments';
import { attemptExpired, paidOut, settle, settleRound } from './settle';
import type { Context } from './types';

// What the mode puts in a managed reference's or a timer's meta, and gets
// back on the event: enough to find the document it was set for.
export type EventMeta =
  | { kind: 'entry'; wallet: string; id: string }
  | { kind: 'deadline'; wallet: string; id: string }
  | { kind: 'payout'; path: string; origin: string };

function eventMeta(meta: Json): EventMeta | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const { kind, wallet, id, path, origin } = meta;
  if ((kind === 'entry' || kind === 'deadline') && typeof wallet === 'string' && typeof id === 'string')
    return { kind, wallet, id };
  if (kind === 'payout' && typeof path === 'string' && typeof origin === 'string')
    return { kind, path, origin };
  return null;
}

// An event for a document this store never had, or a transaction that is not
// the entry's payment: retrying would not change the answer, so the delivery
// is acknowledged, not failed.
const settled = (error: unknown) =>
  error instanceof GameError && (error.code === 'game_not_found' || error.code === 'payment_mismatch');

export type P2PWebhookHandlers = Required<Pick<BankrollWebhookHandlers, 'onConfirmed' | 'onExpired' | 'onFired'>>;

/** The handlers for `bankrollWebhook` on /api/bankroll/webhook. */
export function webhookHandlers<G, C extends Json>(ctx: Context<G, C>): P2PWebhookHandlers {
  return {
    async onConfirmed(event) {
      const meta = eventMeta(event.meta);
      if (meta?.kind === 'payout') {
        await paidOut(ctx, meta.path, event.reference, event.signature);
        return;
      }
      if (meta?.kind !== 'entry') return;
      try {
        await confirmEntry(ctx, meta.wallet, meta.id, event.signature);
      } catch (error) {
        if (!settled(error)) throw error;
        console.warn(`p2p: reference.confirmed for entry ${meta.id} ignored: ${(error as Error).message}`);
      }
    },
    async onExpired(event) {
      const meta = eventMeta(event.meta);
      if (meta?.kind === 'payout') {
        // Bankroll saw nothing land for this attempt: it is over, and settle
        // builds a fresh one for what is still owed.
        if (await attemptExpired(ctx, meta.path, event.reference)) await settle(ctx, meta.path, meta.origin);
        return;
      }
      if (meta?.kind !== 'entry') return;
      try {
        await expireEntry(ctx, meta.wallet, meta.id, event.reference);
      } catch (error) {
        if (!settled(error)) throw error;
      }
    },
    async onFired(event) {
      const meta = eventMeta(event.meta);
      if (meta?.kind !== 'deadline') return;
      try {
        // The start deadline passed with nobody reading the round: the read
        // inside settleRound applies the forfeit and pays.
        await settleRound(ctx, meta.wallet, meta.id);
      } catch (error) {
        if (!settled(error)) throw error;
      }
    },
  };
}
