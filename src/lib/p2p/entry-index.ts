import type { StoreBackend } from '@joinbankroll/sdk/store';

import { GameError } from '@/lib/game-error';

export const ENTRY_INDEX_PREFIX = 'reconciliation/entries/';
export interface IndexedEntry {
  wallet: string;
  id: string;
}
export const entryIndexPath = (id: string) => `${ENTRY_INDEX_PREFIX}${id}.json`;

/** Register before creating the round, and therefore before exposing a quote.
 * A crash can leave a harmless pointer to a missing round, never an undiscoverable
 * payment. Pointers are immutable; the game and match remain authoritative.
 * Keep this flat: Blob lists recursively, while the filesystem lists one level.
 */
export async function indexEntry(backend: StoreBackend, wallet: string, id: string): Promise<void> {
  const path = entryIndexPath(id);
  if (await backend.createIfAbsent(path, { wallet, id } satisfies IndexedEntry)) return;
  const existing = await backend.readJson<IndexedEntry>(path);
  if (existing?.value.wallet !== wallet || existing.value.id !== id)
    throw new GameError('entry_index_conflict', 409);
}
