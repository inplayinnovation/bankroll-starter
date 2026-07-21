// Buying, and listing what's been bought.
//
// A loot box costs $1 and pays $1 back when opened — a deliberately trivial
// product, so what's on show is the money loop and the store, not the thing
// being sold. Replace the loot box with whatever you're building; the shape of
// these routes is the part worth keeping.
import { ConfirmChargeError, confirmCharge } from '@joinbankroll/sdk/server';

import '@/lib/rpc';

import { requireIdentity, requireSession, Unauthorized } from '@/lib/session';
import { listPurchases, recordPurchase } from '@/lib/store';
import { requireTreasury } from '@/lib/treasury';

// One price, because the demo is about the money loop rather than a catalogue.
export const PRICE_CENTS = 100;

// A page of history; the client pages with the returned cursor.
const PAGE_SIZE = 20;

export async function GET(request: Request) {
  const session = await requireSession(request);
  const cursor = new URL(request.url).searchParams.get('cursor') ?? undefined;
  const page = await listPurchases(session.user.wallet, { limit: PAGE_SIZE, cursor });
  return Response.json(page);
}

export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    requireIdentity(session);
    const treasury = requireTreasury();

    const { signature } = (await request.json()) as { signature?: string };
    if (!signature) return Response.json({ error: 'signature is required' }, { status: 400 });

    // 1. What actually settled on-chain? A return value means it settled.
    const charge = await confirmCharge(signature);

    // 2. Does it match what we expected? All three checks release value.
    //    The payee check is the one to never skip: any settled transfer passes
    //    the other two, including one the user sent to their own second wallet.
    if (charge.payee !== treasury.address) {
      return Response.json({ error: 'payment went to another address' }, { status: 400 });
    }
    if (charge.amountCents !== PRICE_CENTS) {
      return Response.json({ error: 'payment amount does not match' }, { status: 400 });
    }
    if (charge.payer !== session.user.wallet) {
      return Response.json({ error: 'payment came from another wallet' }, { status: 400 });
    }

    // 3. Record it. This single atomic create is also the replay guard — the id
    //    is derived from the transaction (its slot and signature), so a second
    //    attempt computes the same id and cannot create the same document.
    //    There is no separate "spend the signature" step to leave unfinished.
    const { created, purchase } = await recordPurchase(
      session.user.wallet,
      signature,
      charge.slot,
      charge.amountCents,
    );

    // A repeat is not a failure. A retried request and a replayed one look
    // identical, and both are already satisfied by the purchase that exists.
    return Response.json({ purchase }, { status: created ? 201 : 200 });
  } catch (error) {
    if (error instanceof Unauthorized) {
      return Response.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof ConfirmChargeError) {
      return Response.json({ error: `payment not confirmed: ${error.code}` }, { status: 402 });
    }
    throw error;
  }
}
