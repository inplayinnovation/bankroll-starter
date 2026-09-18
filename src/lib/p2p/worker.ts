import { randomUUID } from 'node:crypto';

import { PreconditionFailed, type StoreBackend } from '@joinbankroll/sdk/store';

import { GameError } from '@/lib/game-error';

import { ENTRY_INDEX_PREFIX, type IndexedEntry } from './entry-index';

export const RECONCILIATION_STATE = 'reconciliation/worker.json';
export const LEASE_MS = 90_000;

interface RunStats {
  processed: number;
  failed: number;
  missing: number;
  completedPass: boolean;
}
export interface ReconciliationState {
  owner: string | null;
  leaseUntil: number;
  cursor?: string;
  lastCompletedPassAt: number | null;
  lastRun?: RunStats & { finishedAt: number };
}

/** A bounded, resumable sweep of the immutable entry index. Scope overrides
 * let tests use their own index/checkpoint on the selected real store; HTTP
 * callers never choose a scope, cursor, wallet, or payout destination.
 */
export async function runReconciliation(
  backend: StoreBackend,
  reconcileEntry: (wallet: string, id: string, origin: string) => Promise<void>,
  origin: string,
  {
    indexPrefix = ENTRY_INDEX_PREFIX,
    statePath = RECONCILIATION_STATE,
    limit = 25,
    budgetMs = 45_000,
  } = {},
) {
  const owner = randomUUID();
  await backend.createIfAbsent(statePath, {
    owner: null,
    leaseUntil: 0,
    lastCompletedPassAt: null,
  } satisfies ReconciliationState);
  const stored = (await backend.readJson<ReconciliationState>(statePath))!;
  if (stored.value.leaseUntil > Date.now()) return { skipped: true as const };
  let state: ReconciliationState = { ...stored.value, owner, leaseUntil: Date.now() + LEASE_MS };
  try {
    await backend.writeJson(statePath, state, stored.etag);
  } catch (error) {
    if (error instanceof PreconditionFailed) return { skipped: true as const };
    throw error;
  }

  async function checkpoint(next: ReconciliationState) {
    const current = (await backend.readJson<ReconciliationState>(statePath))!;
    if (current.value.owner !== owner) throw new Error('reconciliation_lease_lost');
    await backend.writeJson(statePath, next, current.etag);
    state = next;
  }

  const stats: RunStats = { processed: 0, failed: 0, missing: 0, completedPass: false };
  const started = performance.now();
  try {
    while (stats.processed < limit && performance.now() - started < budgetMs) {
      // One item keeps the cursor meaningful on both SDK backends. Advance
      // before work: a killed/hung item cannot starve everything behind it.
      // The index is permanent and wraps, so that item is retried next pass.
      const page = await backend.list<IndexedEntry>(indexPrefix, {
        limit: 1,
        cursor: state.cursor,
      });
      stats.completedPass = !page.cursor;
      await checkpoint({
        ...state,
        cursor: page.cursor,
        leaseUntil: Date.now() + LEASE_MS,
      });
      const entry = page.items[0];
      if (entry) {
        stats.processed++;
        try {
          await reconcileEntry(entry.wallet, entry.id, origin);
        } catch (error) {
          // An index write can precede a failed/unfinished game create. Keep
          // the pointer: a concurrent creator may still finish its write.
          if (error instanceof GameError && error.code === 'game_not_found') stats.missing++;
          else {
            stats.failed++;
            // Never log payment references, signatures, or credential-bearing
            // SDK error messages. Failed entries remain in the next pass.
            console.error('reconciliation_failed', {
              id: entry.id,
              code:
                error instanceof Error && 'code' in error ? String(error.code) : 'unexpected_error',
            });
          }
        }
      }
      if (stats.completedPass) {
        await checkpoint({ ...state, lastCompletedPassAt: Date.now() });
        break;
      }
    }
    return { skipped: false as const, ...stats };
  } finally {
    const current = await backend.readJson<ReconciliationState>(statePath);
    if (current?.value.owner === owner) {
      try {
        await backend.writeJson(
          statePath,
          {
            ...current.value,
            owner: null,
            leaseUntil: 0,
            lastRun: { ...stats, finishedAt: Date.now() },
          } satisfies ReconciliationState,
          current.etag,
        );
      } catch (error) {
        if (!(error instanceof PreconditionFailed)) throw error;
      }
    }
  }
}
