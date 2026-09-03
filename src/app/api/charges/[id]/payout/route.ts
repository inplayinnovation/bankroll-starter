// Paying a charge back out: the sending half of the money loop.
//
// The starter returns the same amount it charged, so the two directions are
// visible side by side. The lifecycle is build → sign → STORE → send →
// confirm, all compare-and-swapped on the charge's own document — and the
// stored signature is the whole safety story. Signing is deterministic, so
// the transaction's on-chain id is known before anything is broadcast, and it
// is recorded in the same write that wins `held → paying`: there is no crash
// window in which money can move under an id this document doesn't know.
//
// Recovery therefore never asks "did my send go through?" — it asks
// confirmPayout(stored signature), which has a definite answer: confirmed
// (→ paid), `expired` (ledger-searched proof the attempt never landed and
// never can — the one license to build a fresh transaction), or not yet
// (→ still `paying`; ask again). Only one caller wins the transition, so only
// one live payout is ever signed, and a second transaction for the same
// charge can only exist once the first is proven dead. That is the whole
// double-pay argument.
import { requireIdentity, requireSession, Unauthorized } from '@joinbankroll/sdk/next';
import {
  PayError,
  buildAndSignPayout,
  confirmPayout,
  requireTreasury,
  sendPayout,
} from '@joinbankroll/sdk/server';

import { payoutsAvailable } from '@/lib/app-identity';
import { getCharge, updateCharge, type Charge } from '@/lib/store';

class NotPayable extends Error {
  constructor(status: string) {
    super(`charge is ${status} and cannot be paid out`);
    this.name = 'NotPayable';
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    // Charge-only mode: BANKROLL_PAYEE names where money arrives, and nothing
    // here can sign a transfer out of it.
    if (!payoutsAvailable()) {
      return Response.json(
        { error: 'payouts are not available: this app has no treasury key' },
        { status: 501 },
      );
    }
    const session = await requireSession(request);
    requireIdentity(session);
    const signer = requireTreasury();
    const wallet = session.user.wallet;
    const { id } = await params;

    // The id lives under the caller's own prefix, so this only ever finds a
    // charge they paid — a user cannot cash out someone else's.
    let charge = await getCharge(wallet, id);
    if (!charge) return Response.json({ error: 'charge not found' }, { status: 404 });

    // Already paid out — idempotent, return what they got.
    if (charge.status === 'paid') return Response.json({ charge });
    if (charge.status === 'failed') throw new NotPayable(charge.status);

    // The payout stayed `paying` — record why, and let a later call resolve
    // it. Every PayError routes here: `expired` licenses the next call to
    // rebuild; anything else means ask again. Blind-retrying an unknown
    // outcome is how double payments happen.
    const stillPaying = async (payout: NonNullable<Charge['payout']>, code: string) => {
      const pending = await updateCharge(wallet, id, (current) => ({
        ...current,
        payout: { ...payout, error: code },
      }));
      return Response.json({ charge: pending, pending: true }, { status: 202 });
    };

    // Fresh bytes may exist only where nothing is recorded, or the recorded
    // attempt is proven dead. A live recorded payout is resolved by its
    // signature below — never resent, never rebuilt on a guess.
    if (charge.payout === undefined || charge.payout.error === 'expired') {
      // Pay back in the asset that paid. A charge settled in this app's own
      // token returns that token, never HSUSD — otherwise credit the app gives
      // away for free would be a route to real money.
      const signed = await buildAndSignPayout(
        {
          to: wallet,
          amountCents: charge.amountCents,
          memo: `payout:${id}`,
          token: charge.mint,
        },
        { signer },
      );
      charge = await updateCharge(wallet, id, (current) => {
        // Someone else recorded a live payout first — theirs is the one to
        // resolve; ours was never broadcast and simply expires unused.
        if (current.status === 'paying' && current.payout?.error !== 'expired') return current;
        if (current.status !== 'held' && current.status !== 'paying') {
          throw new NotPayable(current.status);
        }
        return {
          ...current,
          status: 'paying',
          payout: {
            signature: signed.signature,
            lastValidBlockHeight: signed.lastValidBlockHeight,
          },
        };
      });

      // Send only the attempt this call signed AND recorded. The signature is
      // already durable, so a failure past this point changes nothing the
      // chain can't later answer.
      const recorded = charge.payout;
      if (recorded !== undefined && recorded.signature === signed.signature) {
        try {
          await sendPayout(signed.transaction, { signer });
        } catch (error) {
          if (error instanceof PayError) return await stillPaying(recorded, error.code);
          throw error;
        }
      }
    }

    const payout = charge.payout;
    if (payout === undefined)
      throw new Error(`charge ${id} is ${charge.status} with no recorded payout`);

    // Resolve by the stored signature. A timeout is not a failure — the
    // payout may still land, so the charge stays `paying` and another call
    // asks again.
    try {
      await confirmPayout(payout.signature, { lastValidBlockHeight: payout.lastValidBlockHeight });
    } catch (error) {
      if (error instanceof PayError) return await stillPaying(payout, error.code);
      throw error;
    }

    const paid = await updateCharge(wallet, id, (current) => ({
      ...current,
      status: 'paid',
      paidAt: new Date().toISOString(),
    }));
    return Response.json({ charge: paid });
  } catch (error) {
    if (error instanceof Unauthorized) {
      return Response.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof NotPayable) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
