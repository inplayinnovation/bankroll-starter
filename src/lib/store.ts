// What this app remembers: one document per charge.
//
// The store itself — the backend interface, the compare-and-swap, the id scheme
// — is @joinbankroll/sdk/store. What's here is only this app's domain: a charge
// this app took, and whether it has been paid back out. Replace it with whatever
// your app actually sells; a chess app has games and winners, not charges.
//
// Every state change is a compare-and-swap on one document. That is the whole
// reason this is safe on a store with no transactions: nothing here spans two
// keys, so there is never a pair to keep in step and no window to be
// interrupted in.
//
// Note what is absent: a balance. This app does not hold anyone's money — the
// Bankroll host is the wallet. This only records what it charged and what it
// paid back.
import {
  DocumentNotFound,
  sortableId,
  updateJson,
  type StoreBackend,
} from '@joinbankroll/sdk/store';
import { fsBackend, storeDirectory } from '@joinbankroll/sdk/store/fs';
import { vercelBlobBackend } from '@joinbankroll/sdk/store/vercel';

// Set in .env.local when the app is scaffolded, and gitignored — so a
// deployment never sees it and always gets Blob.
const FILESYSTEM_STORE = 'fs';

export const usingFilesystemStore = () => process.env.STORE === FILESYSTEM_STORE;

const backend: StoreBackend = usingFilesystemStore() ? fsBackend() : vercelBlobBackend();

/** Where filesystem-backed data lives, for display. */
export { storeDirectory };

// A charge's id is `<invertedSlot>-<signature>`, and its document lives at
// `charges/<wallet>/<id>.json`. Segments come from wallet addresses and ids,
// so they are encoded rather than trusted to be free of separators.
const chargePath = (wallet: string, id: string) =>
  `charges/${encodeURIComponent(wallet)}/${encodeURIComponent(id)}.json`;
const walletPrefix = (wallet: string) => `charges/${encodeURIComponent(wallet)}/`;

/**
 * A charge, and everything that has happened to it.
 *
 *   held → paying → paid
 *                 ↘ failed
 *
 * `paying` exists because paying a user out is not instantaneous and can fail
 * in ways that need resolving later. The transaction and its expiry are
 * recorded in this document *before* it is broadcast, so a charge whose payout
 * outcome was never learned is visible as `paying` rather than lost.
 */
export type ChargeStatus = 'held' | 'paying' | 'paid' | 'failed';

export interface Charge {
  /** `<invertedSlot>-<signature>` — how you address this charge. */
  id: string;
  /** The on-chain signature of the payment itself. */
  signature: string;
  /**
   * The mint that paid — HSUSD, or one of this app's own tokens. Recorded so
   * the payout returns the same asset: a charge settled in tokens the app gave
   * away must never pay out real money.
   */
  mint: string;
  amountCents: number;
  status: ChargeStatus;
  chargedAt: string;
  paidAt?: string;
  /** Whatever the app needs to remember about what this charge was for. */
  meta?: Record<string, unknown>;
  /** Set once the payout begins; the transfer owed for this charge. */
  payout?: {
    transaction: string;
    lastValidBlockHeight?: number;
    signature?: string;
    error?: string;
  };
}

/** One page of charges, newest first, with a cursor for the next page. */
export interface ChargePage {
  charges: Charge[];
  /** Pass back to list the next page; absent when there are no more. */
  cursor?: string;
}

/**
 * Record a charge against the payment that settled it.
 *
 * This single atomic create is also the replay guard: a signature can buy at
 * most one thing, ever, because a second attempt computes the same id and
 * cannot create the same document. `created: false` means it was already
 * recorded — return the existing charge rather than treating it as an error,
 * since a retried request and a replayed one are indistinguishable and both are
 * already satisfied.
 */
export async function recordCharge(
  wallet: string,
  signature: string,
  slot: number,
  amountCents: number,
  mint: string,
  meta?: Record<string, unknown>,
): Promise<{ created: boolean; charge: Charge }> {
  const id = sortableId(slot, signature);
  const pathname = chargePath(wallet, id);
  const charge: Charge = {
    id,
    signature,
    mint,
    amountCents,
    status: 'held',
    chargedAt: new Date().toISOString(),
    ...(meta ? { meta } : {}),
  };

  if (await backend.createIfAbsent(pathname, charge)) return { created: true, charge };

  const stored = await backend.readJson<Charge>(pathname);
  if (!stored) throw new Error(`charge ${id} exists but could not be read`);
  return { created: false, charge: stored.value };
}

export async function getCharge(wallet: string, id: string): Promise<Charge | null> {
  const stored = await backend.readJson<Charge>(chargePath(wallet, id));
  return stored?.value ?? null;
}

/**
 * A page of a wallet's charges, newest first. The key ordering does the
 * sorting, so this stays cheap however long the history: one listing plus a
 * read per charge *on the page*, never the whole history.
 */
export async function listCharges(
  wallet: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<ChargePage> {
  const { items, cursor } = await backend.list<Charge>(walletPrefix(wallet), options);
  return { charges: items, ...(cursor ? { cursor } : {}) };
}

export class ChargeNotFound extends Error {
  constructor(id: string) {
    super(`no charge found for ${id}`);
    this.name = 'ChargeNotFound';
  }
}

/**
 * Move a charge through its lifecycle under compare-and-swap.
 *
 * `change` sees the current charge and returns the next one, or throws to abort
 * without writing. Retries on a lost race, so a concurrent caller cannot
 * clobber a transition — which is what makes "pay out exactly once" hold
 * without a second document to guard it.
 */
export async function updateCharge(
  wallet: string,
  id: string,
  change: (current: Charge) => Charge,
): Promise<Charge> {
  try {
    return await updateJson<Charge>(backend, chargePath(wallet, id), change);
  } catch (error) {
    // The store speaks in pathnames; callers here speak in charge ids.
    if (error instanceof DocumentNotFound) throw new ChargeNotFound(id);
    throw error;
  }
}
