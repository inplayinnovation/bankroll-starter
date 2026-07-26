// Durable state — no database to provision.
//
// Two backends, one interface (see ./backend.ts). Local development writes
// files so the app runs without a Vercel account; a deployment uses Vercel
// Blob. Nothing below this line knows which is live, which is what lets the
// same code deploy unchanged.
//
// One document per purchase, and every state change is a compare-and-swap on
// that one document. That is the whole reason this is safe on a store with no
// transactions: nothing here spans two keys, so there is never a pair to keep
// in step and no window to be interrupted in.
//
// Note what is absent: a balance. The app does not hold anyone's money — the
// Bankroll host is the wallet. The app sells things and remembers what was
// bought, which is one document per sale.
import { PreconditionFailed, type StoreBackend } from './backend';
import { blobBackend } from './blob';
import { fsBackend, storeDirectory } from './fs';

const FILESYSTEM_STORE = 'fs';
const CAS_ATTEMPTS = 5;

// Set by `npm run bankroll` in .env.local, which is gitignored — so a
// deployment never sees it and always gets Blob.
const backend: StoreBackend = process.env.STORE === FILESYSTEM_STORE ? fsBackend : blobBackend;

export const usingFilesystemStore = () => process.env.STORE === FILESYSTEM_STORE;

/** Where filesystem-backed data lives, for display. Re-exported so callers
 *  never hardcode the path — it moved once already. */
export { storeDirectory };

// A purchase's id is `<invertedSlot>-<signature>`, and its document lives at
// `purchases/<wallet>/<id>.json`. Both parts come from the transaction, so the
// id is the same on every attempt — which is what makes the create the replay
// guard. And because a listing can only order by key, the slot goes first: an
// object store sorts keys lexicographically, so inverting the slot (largest
// first) makes a listing come back newest-first without any post-sort.
//
// The signature sits *after* the slot, so it isn't a key prefix — a caller can
// only look a purchase up by its full id, which the write path returns and the
// list carries. Recovering a purchase from a bare signature (support: "I paid,
// here's my tx") is a route-layer concern: confirmCharge yields the slot, and
// buildId rebuilds the id. The store stays off the chain.
//
// Slots are u64 on-chain but the SDK surfaces them as a JS number, so
// MAX_SAFE_INTEGER is the ceiling and 16 digits is its width.
const SLOT_CEILING = Number.MAX_SAFE_INTEGER;
const SLOT_WIDTH = String(SLOT_CEILING).length;

export function buildId(slot: number, signature: string): string {
  return `${String(SLOT_CEILING - slot).padStart(SLOT_WIDTH, '0')}-${signature}`;
}

// Segments come from wallet addresses and ids, so they are encoded rather than
// trusted to be free of separators.
const purchasePath = (wallet: string, id: string) =>
  `purchases/${encodeURIComponent(wallet)}/${encodeURIComponent(id)}.json`;
const walletPrefix = (wallet: string) => `purchases/${encodeURIComponent(wallet)}/`;

/**
 * A purchase, and everything that has happened to it.
 *
 *   unconsumed → consuming → consumed
 *                         ↘ failed
 *
 * `consuming` exists because paying a user out is not instantaneous and can
 * fail in ways that need resolving later. The transaction and its expiry are
 * recorded in this document *before* it is broadcast, so a purchase whose
 * outcome was never learned is visible as `consuming` rather than lost.
 */
export type PurchaseStatus = 'unconsumed' | 'consuming' | 'consumed' | 'failed';

export interface Purchase {
  /** `<invertedSlot>-<signature>` — how you address this purchase. */
  id: string;
  /** The payment signature that bought it. */
  signature: string;
  /**
   * The mint that paid — HSUSD, or one of this app's own tokens. Recorded so
   * opening pays back in the same asset: a box bought with tokens the app gave
   * away must never pay out real money.
   */
  mint: string;
  amountCents: number;
  status: PurchaseStatus;
  purchasedAt: string;
  consumedAt?: string;
  /** Whatever the app needs to remember about what was sold. */
  meta?: Record<string, unknown>;
  /** Set once consuming begins; the payout owed for it. */
  payout?: {
    transaction: string;
    lastValidBlockHeight?: number;
    signature?: string;
    error?: string;
  };
}

/** One page of purchases, newest first, with a cursor for the next page. */
export interface PurchasePage {
  purchases: Purchase[];
  /** Pass back to list the next page; absent when there are no more. */
  cursor?: string;
}

/**
 * Record a purchase against the payment that bought it.
 *
 * This single atomic create is also the replay guard: a signature can buy at
 * most one thing, ever, because a second attempt computes the same id and
 * cannot create the same document. `created: false` means it was already
 * bought — return the existing purchase rather than treating it as an error,
 * since a retried request and a replayed one are indistinguishable and both are
 * already satisfied.
 */
export async function recordPurchase(
  wallet: string,
  signature: string,
  slot: number,
  amountCents: number,
  mint: string,
  meta?: Record<string, unknown>,
): Promise<{ created: boolean; purchase: Purchase }> {
  const id = buildId(slot, signature);
  const pathname = purchasePath(wallet, id);
  const purchase: Purchase = {
    id,
    signature,
    mint,
    amountCents,
    status: 'unconsumed',
    purchasedAt: new Date().toISOString(),
    ...(meta ? { meta } : {}),
  };

  if (await backend.createIfAbsent(pathname, purchase)) return { created: true, purchase };

  const stored = await backend.readJson<Purchase>(pathname);
  if (!stored) throw new Error(`purchase ${id} exists but could not be read`);
  return { created: false, purchase: stored.value };
}

export async function getPurchase(wallet: string, id: string): Promise<Purchase | null> {
  const stored = await backend.readJson<Purchase>(purchasePath(wallet, id));
  return stored?.value ?? null;
}

/**
 * A page of a wallet's purchases, newest first. The key ordering does the
 * sorting, so this stays cheap however long the history: one listing plus a
 * read per purchase *on the page*, never the whole history.
 */
export async function listPurchases(
  wallet: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<PurchasePage> {
  const { items, cursor } = await backend.list<Purchase>(walletPrefix(wallet), options);
  return { purchases: items, ...(cursor ? { cursor } : {}) };
}

export class PurchaseNotFound extends Error {
  constructor(id: string) {
    super(`no purchase found for ${id}`);
    this.name = 'PurchaseNotFound';
  }
}

export class PurchaseAlreadyConsumed extends Error {
  constructor(id: string) {
    super(`purchase ${id} has already been consumed`);
    this.name = 'PurchaseAlreadyConsumed';
  }
}

/**
 * Move a purchase through its lifecycle under compare-and-swap.
 *
 * `change` sees the current purchase and returns the next one, or throws to
 * abort without writing. Retries on a lost race, so a concurrent caller cannot
 * clobber a transition — which is what makes "consume exactly once" hold
 * without a second document to guard it.
 */
export async function updatePurchase(
  wallet: string,
  id: string,
  change: (current: Purchase) => Purchase,
): Promise<Purchase> {
  const pathname = purchasePath(wallet, id);
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const stored = await backend.readJson<Purchase>(pathname);
    if (!stored) throw new PurchaseNotFound(id);
    const next = change(stored.value);
    try {
      await backend.writeJson(pathname, next, stored.etag);
      return next;
    } catch (error) {
      // Someone else transitioned it — re-read and decide again against theirs.
      if (error instanceof PreconditionFailed) continue;
      throw error;
    }
  }
  throw new Error(`purchase ${id} is too contended to update`);
}
