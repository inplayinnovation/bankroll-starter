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
// build; a Privy signer replays the same idempotency key for a day and
// declares that window. Bankroll watches for the whole window and reports
// expiry only after it, which is what makes a fresh transaction safe.
const KEYPAIR_WINDOW_SECONDS = 5 * 60;
// A send answers within seconds. A caller that finds an attempt without an
// answer sooner than this is racing a live send, not recovering a lost one.
const RESEND_AFTER_MS = 30_000;

interface Owing {
  payout: Payout | null;
}

const windowFor = (signer: PaymentSigner) =>
  signer.replayWindowMs ? Math.ceil(signer.replayWindowMs / 1000) : KEYPAIR_WINDOW_SECONDS;

/**
 * Pay what a document owes, once per attempt. The attempt's managed
 * reference and built bytes are on the document before the send, so a retry
 * inside the window resends the same transaction under the same idempotency
 * key, and a fresh transaction is built only once Bankroll has let the
 * reference expire. Nothing here waits for the chain: the landing arrives
 * on the webhook as `reference.confirmed`.
 */
export async function settle<G, C extends Json>(
  ctx: Context<G, C>,
  path: string,
  origin: string,
): Promise<Payout | null> {
  const stored = await ctx.store.readJson<Owing>(path);
  const payout = stored?.value.payout ?? null;
  if (!payout || payout.status === 'paid') return payout;
  let attempt = payout.attempt;
  const live = attempt !== null && Date.parse(attempt.expiresAt) > Date.now();
  if (live && (attempt!.signature !== null || Date.now() - attempt!.startedAt < RESEND_AFTER_MS)) return payout;
  let signer: PaymentSigner;
  if (live) {
    signer = ctx.payoutSigner(attempt!.idempotencyKey);
  } else {
    const idempotencyKey = randomUUID();
    signer = ctx.payoutSigner(idempotencyKey);
    const { reference, expiresAt } = await createManagedReference(
      { meta: { kind: 'payout', path, origin }, expiresInSeconds: windowFor(signer) },
      { origin },
    );
    const built = await buildPayout(
      { recipients: payout.recipients, memo: payout.memo, reference },
      { signer },
    );
    attempt = {
      reference,
      expiresAt,
      idempotencyKey,
      startedAt: Date.now(),
      transaction: built.transaction,
      signature: null,
    };
    const written = await updateJson<Owing>(ctx.store, path, (current) => {
      if (!current.payout || current.payout.status === 'paid') return current;
      // Two callers can get here together: two reads crossing the start
      // deadline, two finishing transitions, an expiry racing a request.
      // The first to install a live attempt sends; a live attempt is never
      // replaced, so the other backs off and its reference expires unseen.
      const existing = current.payout.attempt;
      if (existing && Date.parse(existing.expiresAt) > Date.now()) return current;
      return { ...current, payout: { ...current.payout, attempt } };
    });
    // The key is random per caller; the reference is not always (the mock derives it).
    if (written.payout?.attempt?.idempotencyKey !== idempotencyKey) return written.payout;
  }
  const { signature } = await sendPayout(attempt!.transaction, { signer });
  const sent = await updateJson<Owing>(ctx.store, path, (current) =>
    current.payout?.attempt?.idempotencyKey === attempt!.idempotencyKey && current.payout.status !== 'paid'
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
