import { randomUUID } from 'node:crypto';

import type { Json } from '@joinbankroll/sdk/matchmaking';
import {
  buildPayout,
  createManagedReference,
  sendPayout,
  type PaymentSigner,
} from '@joinbankroll/sdk/server';
import { updateJson } from '@joinbankroll/sdk/store';

import { finalRound, readEntry, roundPath } from './entries';
import { matchPath, resolveMatch } from './settlement';
import type { Context, Payout } from './types';

// A keypair's transaction dies with its blockhash, a minute or two after the
// build, with room here for a stalled chain; a Privy signer replays the same
// idempotency key for a day and declares that window. Bankroll watches for
// the whole window and reports expiry only after it, which is what makes a
// fresh transaction safe.
const KEYPAIR_WINDOW_SECONDS = 15 * 60;

interface Owing {
  payout: Payout | null;
}

const windowFor = (signer: PaymentSigner) =>
  signer.replayWindowMs ? Math.ceil(signer.replayWindowMs / 1000) : KEYPAIR_WINDOW_SECONDS;

/**
 * Pay what a document owes, once per attempt. The attempt's managed
 * reference and built bytes are on the document before the send. From then
 * on the attempt is Bankroll's to end: `reference.confirmed` closes the
 * payout, `reference.expired` clears the attempt and a fresh transaction is
 * built. Nothing here waits for the chain, and nothing is ever sent twice:
 * an attempt whose send never answered waits for Bankroll like any other.
 */
export async function settle<G, C extends Json>(
  ctx: Context<G, C>,
  path: string,
  origin: string,
): Promise<Payout | null> {
  const stored = await ctx.store.readJson<Owing>(path);
  const payout = stored?.value.payout ?? null;
  if (!payout || payout.status === 'paid') return payout;
  if (payout.attempt !== null) return payout;
  const idempotencyKey = randomUUID();
  const signer = ctx.payoutSigner(idempotencyKey);
  const { reference, expiresAt } = await createManagedReference(
    { meta: { kind: 'payout', path, origin }, expiresInSeconds: windowFor(signer) },
    { origin },
  );
  const built = await buildPayout({ recipients: payout.recipients, memo: payout.memo, reference }, { signer });
  const attempt = { reference, expiresAt, idempotencyKey, transaction: built.transaction, signature: null };
  const written = await updateJson<Owing>(ctx.store, path, (current) => {
    if (!current.payout || current.payout.status === 'paid') return current;
    // Two callers can get here together: two reads crossing the start
    // deadline, two finishing transitions, an expiry racing a request. The
    // first to install an attempt sends; an attempt is never replaced, so
    // the other backs off and its reference expires unseen.
    if (current.payout.attempt !== null) return current;
    return { ...current, payout: { ...current.payout, attempt } };
  });
  // The key is random per caller; the reference is not always (the mock derives it).
  if (written.payout?.attempt?.idempotencyKey !== idempotencyKey) return written.payout;
  const { signature } = await sendPayout(attempt.transaction, { signer });
  const sent = await updateJson<Owing>(ctx.store, path, (current) =>
    current.payout?.attempt?.idempotencyKey === idempotencyKey && current.payout.status !== 'paid'
      ? {
          ...current,
          payout: {
            ...current.payout,
            status: 'sent',
            attempt: { ...current.payout.attempt, signature },
          },
        }
      : current,
  );
  return sent.payout;
}

/**
 * Bankroll saw a transaction carrying the attempt's reference land. This app
 * built and sent that transaction itself, so the signature the send answered
 * is the proof: a report of some other signature is not this payout and is
 * left alone. A send whose answer was lost has no signature to compare;
 * Bankroll's report is then the first word on it.
 */
export async function paidOut<G, C extends Json>(
  ctx: Context<G, C>,
  path: string,
  reference: string,
  signature: string,
): Promise<void> {
  await updateJson<Owing>(ctx.store, path, (current) => {
    const attempt = current.payout?.attempt;
    if (!current.payout || current.payout.status === 'paid' || attempt?.reference !== reference) return current;
    if (attempt.signature !== null && attempt.signature !== signature) {
      console.warn(`p2p: ${path} reported paid by ${signature}, not the ${attempt.signature} this app sent; ignored`);
      return current;
    }
    return { ...current, payout: { ...current.payout, status: 'paid', signature } };
  });
}

/**
 * Pay what a round owes: the refund of a cancelled paid entry, or the match
 * its finished play belongs to. Never starts a round or reveals play state.
 */
export async function settleRound<G, C extends Json>(
  ctx: Context<G, C>,
  wallet: string,
  id: string,
  origin: string,
): Promise<void> {
  const round = await readEntry(ctx, wallet, id);
  const entryOrigin = round.entry.origin || origin;
  if (round.entry.status === 'cancelled') {
    if (round.entry.payment.signature) await settle(ctx, roundPath(wallet, id), entryOrigin);
    return;
  }
  if (!finalRound(ctx, round)) return;
  const match = await resolveMatch(ctx, round);
  if (match) await settle(ctx, matchPath(match.id), entryOrigin);
}

/**
 * Bankroll reported the attempt's reference expired: nothing carrying it
 * landed, so the attempt is cleared. True when that was the attempt in
 * flight; a stale expiry for some earlier attempt changes nothing.
 */
export async function attemptExpired<G, C extends Json>(
  ctx: Context<G, C>,
  path: string,
  reference: string,
): Promise<boolean> {
  const updated = await updateJson<Owing>(ctx.store, path, (current) =>
    current.payout?.attempt?.reference === reference && current.payout.status !== 'paid'
      ? { ...current, payout: { ...current.payout, status: 'pending', attempt: null } }
      : current,
  );
  return updated.payout?.attempt === null && updated.payout.status === 'pending';
}
