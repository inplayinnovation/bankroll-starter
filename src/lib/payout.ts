// Paying a charge back out: the sending half of the money loop.
//
// The lifecycle is build → STORE → send → store the signature → confirm, all
// compare-and-swapped on the charge's own document. A server wallet signs at
// send time (it re-signs on a fresh blockhash), so no signature exists
// before the broadcast; what does exist is the attempt's reference — an id
// carried on the transfer — its idempotency key, and its exact bytes, and
// those are recorded in the same write that wins `held → paying`. There is no
// crash window in which money can move under an attempt this document doesn't
// know.
//
// Recovery therefore never asks "did my send go through?" — it asks the chain
// for the reference (findPayoutByReference) when the signature was never
// stored, and confirmPayout(stored signature) once it was. Nothing found means
// the recorded bytes are resent under the same idempotency key, which the
// server wallet dedupes for 24h: a resend of an attempt that did land resolves
// to its original signature, never a second transfer. `failed_on_chain` — it
// landed and failed, so no funds moved — is the one license to build a fresh
// transaction. Only one caller wins each transition, so only one live attempt
// exists at a time. That is the whole double-pay argument.
import {
  PayError,
  buildPayout,
  confirmPayout,
  createReference,
  findPayoutByReference,
  sendPayout,
} from '@joinbankroll/sdk/server';

import { getCharge, updateCharge, type Charge } from '@/lib/store';
import { payoutSigner } from '@/lib/treasury';

/** The charge cannot be paid out as it stands; `status` says why. */
export class NotPayable extends Error {
  constructor(readonly status: string) {
    super(`charge is ${status} and cannot be paid out`);
    this.name = 'NotPayable';
  }
}

/** Nothing is owed under this id for this wallet. */
export class PayoutChargeNotFound extends Error {
  constructor(id: string) {
    super(`no charge found for ${id}`);
    this.name = 'PayoutChargeNotFound';
  }
}

export type SettleOutcome =
  /** Money is where it should be — including a settled zero. */
  | { state: 'paid'; charge: Charge }
  /**
   * A transfer is live but unresolved. The attempt is durable on the charge,
   * so asking again later is always safe and never builds a second one.
   */
  | { state: 'pending'; charge: Charge; code: string };

type Payout = NonNullable<Charge['payout']>;

/** The one outcome that licenses a fresh transaction: it landed and failed, so no funds moved. */
const DEAD = 'failed_on_chain';

/**
 * What a charge pays back: what the app recorded as owed on it, or the amount
 * charged. The app records a prize or a loss by setting `owedCents` in the
 * charge's `meta` (a loser's charge gets 0) — the only knob game logic
 * needs, and the only way the amount ever differs from the charge.
 */
export function owedCents(charge: Charge): number {
  const owed = charge.meta?.owedCents;
  if (typeof owed === 'number' && Number.isInteger(owed) && owed >= 0) return owed;
  return charge.amountCents;
}

/**
 * Pay a charge what it is owed, exactly once.
 *
 * Safe to call concurrently with itself and from anywhere: every transition is
 * compare-and-swap on the one charge document, so a player and the sweep
 * racing to settle the same charge produce one payout between them.
 */
export async function settlePayout(wallet: string, id: string): Promise<SettleOutcome> {
  // The id lives under the caller's own prefix, so a request only ever finds a
  // charge that wallet paid — nobody can cash out someone else's.
  let charge = await getCharge(wallet, id);
  if (!charge) throw new PayoutChargeNotFound(id);

  // Already paid out — idempotent, return what they got.
  if (charge.status === 'paid') return { state: 'paid', charge };
  if (charge.status === 'failed') throw new NotPayable(charge.status);

  const payoutCents = owedCents(charge);

  // A zero result is settled entirely in the store. Building a zero-value
  // transfer would add fees and failure modes without moving value.
  if (payoutCents === 0) {
    const paid = await updateCharge(wallet, id, (current) => {
      if (current.status === 'paid') return current;
      if (current.status !== 'held') throw new NotPayable(current.status);
      return { ...current, status: 'paid', paidAt: new Date().toISOString() };
    });
    return { state: 'paid', charge: paid };
  }

  // The payout stayed `paying` — record why, and let a later call resolve it.
  // Every PayError routes here: `failed_on_chain` licenses the next call to
  // rebuild; anything else means ask again. Blind-retrying an unknown outcome
  // is how double payments happen.
  const stillPaying = async (attempt: Payout, code: string): Promise<SettleOutcome> => {
    const pending = await updateCharge(wallet, id, (current) => {
      // Only ever report on the attempt this call actually resolved: on a
      // lost race this callback re-runs against whatever is stored by then.
      if (current.payout?.reference !== attempt.reference) return current;
      return { ...current, payout: { ...current.payout, error: code } };
    });
    return { state: 'pending', charge: pending, code };
  };

  // Fresh bytes may exist only where nothing is recorded, or the recorded
  // attempt is proven dead. A live recorded attempt is resolved below — by its
  // reference, then its signature — never rebuilt on a guess.
  let recordedEarlier = charge.payout !== undefined && charge.payout.error !== DEAD;
  if (!recordedEarlier) {
    const reference = createReference();
    const idempotencyKey = `payout:${id}:${reference}`;
    // Pay back in the asset that paid. A charge settled in this app's own token
    // returns that token, never HSUSD — otherwise credit the app gives away for
    // free would be a route to real money.
    const built = await buildPayout(
      { to: wallet, amountCents: payoutCents, memo: `payout:${id}`, token: charge.mint, reference },
      { signer: payoutSigner(idempotencyKey) },
    );
    charge = await updateCharge(wallet, id, (current) => {
      // Someone else recorded a live attempt first — theirs is the one to
      // resolve; ours was never broadcast and simply expires unused.
      if (current.status === 'paying' && current.payout?.error !== DEAD) return current;
      if (current.status !== 'held' && current.status !== 'paying') {
        throw new NotPayable(current.status);
      }
      return {
        ...current,
        status: 'paying',
        payout: { reference, idempotencyKey, transaction: built.transaction },
      };
    });
    recordedEarlier = charge.payout?.reference !== reference;
  }

  const attempt = charge.payout;
  if (attempt === undefined) {
    throw new Error(`charge ${id} is ${charge.status} with no recorded payout`);
  }

  if (attempt.signature === undefined) {
    let signature: string | undefined;
    if (recordedEarlier) {
      // An earlier call may have sent this attempt and died before storing
      // the signature. The reference on the transfer answers that.
      const found = await findPayoutByReference(attempt.reference);
      if (found?.failed) return await stillPaying(attempt, DEAD);
      signature = found?.signature;
    }
    if (signature === undefined) {
      // Nothing landed under this reference, or nothing was sent yet: send
      // the recorded bytes under the attempt's own idempotency key.
      try {
        ({ signature } = await sendPayout(attempt.transaction, {
          signer: payoutSigner(attempt.idempotencyKey),
        }));
      } catch (error) {
        if (error instanceof PayError) return await stillPaying(attempt, error.code);
        throw error;
      }
    }
    const sent = signature;
    charge = await updateCharge(wallet, id, (current) => {
      if (current.payout?.reference !== attempt.reference) return current;
      return { ...current, payout: { ...current.payout, signature: sent } };
    });
  }

  const payout = charge.payout;
  if (payout === undefined || payout.reference !== attempt.reference || payout.signature === undefined) {
    // Another caller replaced the attempt while this one was sending. Theirs
    // is the live one; a later call resolves it.
    return { state: 'pending', charge, code: 'superseded' };
  }

  // Resolve by the stored signature. No expiry fence: a server wallet re-signs
  // on a fresh blockhash, so the built bytes' own expiry says nothing about
  // what was sent. A timeout is not a failure — the payout may still land, so
  // the charge stays `paying` and another call asks again.
  try {
    await confirmPayout(payout.signature);
  } catch (error) {
    if (error instanceof PayError) return await stillPaying(payout, error.code);
    throw error;
  }

  const paid = await updateCharge(wallet, id, (current) => ({
    ...current,
    status: 'paid',
    paidAt: new Date().toISOString(),
  }));
  return { state: 'paid', charge: paid };
}
