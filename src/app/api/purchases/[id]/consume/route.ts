// Opening a loot box: the payout half of the money loop.
//
// Consuming a purchase pays the user out — here 1:1, the same dollar back. The
// whole payout lifecycle (build → record → send → confirm) runs against the
// purchase's own document, so every step is a compare-and-swap on one key and
// there is nothing to leave half-finished.
//
// The unconsumed → consuming transition is the "open exactly once" guard: only
// one caller wins it, so only one payout is ever built and recorded. A crash
// after that leaves the purchase `consuming` with its transaction stored, and
// calling consume again resumes from those exact bytes — a byte-identical
// re-broadcast is one transfer with one signature, so resuming can't pay twice.
import '@/lib/rpc';

import { PayError, buildPayout, confirmPayout, sendPayout } from '@joinbankroll/sdk/server';

import { requireIdentity, requireSession, Unauthorized } from '@/lib/session';
import { getPurchase, updatePurchase } from '@/lib/store';
import { requireTreasury } from '@/lib/treasury';

class NotConsumable extends Error {
  constructor(status: string) {
    super(`purchase is ${status} and cannot be opened`);
    this.name = 'NotConsumable';
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
    // purchase they made — a user cannot open someone else's.
    let purchase = await getPurchase(wallet, id);
    if (!purchase) return Response.json({ error: 'purchase not found' }, { status: 404 });

    // Already opened — idempotent, return what they got.
    if (purchase.status === 'consumed') return Response.json({ purchase });
    if (purchase.status === 'failed') throw new NotConsumable(purchase.status);

    // Begin. Build the payout, then win the transition that records it. If a
    // concurrent caller already started, keep their recorded transaction — the
    // bytes that get sent must be the ones that got stored, so a resume and a
    // race broadcast the identical transfer.
    if (purchase.status === 'unconsumed') {
      const built = await buildPayout(
        { to: wallet, amountCents: purchase.amountCents, memo: `open:${id}` },
        { signer },
      );
      purchase = await updatePurchase(wallet, id, (current) => {
        if (current.status === 'consuming') return current;
        if (current.status !== 'unconsumed') throw new NotConsumable(current.status);
        return {
          ...current,
          status: 'consuming',
          payout: {
            transaction: built.transaction,
            lastValidBlockHeight: built.lastValidBlockHeight,
          },
        };
      });
    }

    const recorded = purchase.payout;
    if (!recorded) throw new Error(`consuming purchase ${id} has no recorded payout`);

    // Broadcast exactly the recorded bytes, then store the signature.
    const { signature } = await sendPayout(recorded.transaction, { signer });
    await updatePurchase(wallet, id, (current) => ({
      ...current,
      payout: { ...recorded, signature },
    }));

    // Confirm. A timeout is not a failure — the payout may still land, so the
    // purchase stays `consuming` and another consume call resolves it.
    try {
      await confirmPayout(signature, { lastValidBlockHeight: recorded.lastValidBlockHeight });
    } catch (error) {
      if (error instanceof PayError) {
        const pending = await updatePurchase(wallet, id, (current) => ({
          ...current,
          payout: { ...recorded, signature, error: error.code },
        }));
        return Response.json({ purchase: pending, pending: true }, { status: 202 });
      }
      throw error;
    }

    const consumed = await updatePurchase(wallet, id, (current) => ({
      ...current,
      status: 'consumed',
      consumedAt: new Date().toISOString(),
    }));
    return Response.json({ purchase: consumed });
  } catch (error) {
    if (error instanceof Unauthorized) {
      return Response.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof NotConsumable) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
