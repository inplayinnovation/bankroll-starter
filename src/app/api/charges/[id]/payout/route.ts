// Paying a charge back out: the sending half of the money loop.
//
// The starter returns the same amount it charged, so the two directions are
// visible side by side. The whole payout lifecycle (build → record → send →
// confirm) runs against the charge's own document, so every step is a
// compare-and-swap on one key and there is nothing to leave half-finished.
//
// The held → paying transition is the "pay out exactly once" guard: only one
// caller wins it, so only one payout is ever built and recorded. A crash after
// that leaves the charge `paying` with its transaction stored, and calling this
// again resumes from those exact bytes — a byte-identical re-broadcast is one
// transfer with one signature, so resuming cannot pay twice.
//
// The exception is a transaction whose blockhash expired. That one can never
// land, so resuming it would leave the charge `paying` forever; it gets rebuilt
// instead, which is safe because expiry proves nothing moved.
import { requireIdentity, requireSession, Unauthorized } from '@joinbankroll/sdk/next';
import {
  PayError,
  buildPayout,
  confirmPayout,
  requireTreasury,
  sendPayout,
} from '@joinbankroll/sdk/server';

import { getCharge, updateCharge } from '@/lib/store';

class NotPayable extends Error {
  constructor(status: string) {
    super(`charge is ${status} and cannot be paid out`);
    this.name = 'NotPayable';
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
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

    // Begin. Build the payout, then win the transition that records it. If a
    // concurrent caller already started, keep their recorded transaction — the
    // bytes that get sent must be the ones that got stored, so a resume and a
    // race broadcast the identical transfer.
    //
    // Unless that transaction is dead. A payout can only land while its
    // blockhash is valid, and past that no amount of re-broadcasting will
    // change the answer — so rebuild rather than resume, or the charge is stuck
    // in `paying` forever. Safe precisely because `expired` is the one outcome
    // that proves no money moved.
    const expired = charge.payout?.error === 'expired';

    if (charge.status === 'held' || expired) {
      // Pay back in the asset that paid. A charge settled in this app's own
      // token returns that token, never HSUSD — otherwise credit the app gives
      // away for free would be a route to real money.
      const built = await buildPayout(
        {
          to: wallet,
          amountCents: charge.amountCents,
          memo: `payout:${id}`,
          token: charge.mint,
        },
        { signer },
      );
      charge = await updateCharge(wallet, id, (current) => {
        // Someone else recorded a live payout first — take theirs, so only one
        // transaction is ever in flight.
        if (current.status === 'paying' && current.payout?.error !== 'expired') return current;
        if (current.status !== 'held' && current.status !== 'paying') {
          throw new NotPayable(current.status);
        }
        return {
          ...current,
          status: 'paying',
          payout: {
            transaction: built.transaction,
            lastValidBlockHeight: built.lastValidBlockHeight,
          },
        };
      });
    }

    const recorded = charge.payout;
    if (!recorded) throw new Error(`charge ${id} is paying but has no recorded payout`);

    // Broadcast exactly the recorded bytes, then store the signature.
    const { signature } = await sendPayout(recorded.transaction, { signer });
    await updateCharge(wallet, id, (current) => ({
      ...current,
      payout: { ...recorded, signature },
    }));

    // Confirm. A timeout is not a failure — the payout may still land, so the
    // charge stays `paying` and another call resolves it.
    try {
      await confirmPayout(signature, { lastValidBlockHeight: recorded.lastValidBlockHeight });
    } catch (error) {
      if (error instanceof PayError) {
        const pending = await updateCharge(wallet, id, (current) => ({
          ...current,
          payout: { ...recorded, signature, error: error.code },
        }));
        return Response.json({ charge: pending, pending: true }, { status: 202 });
      }
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
