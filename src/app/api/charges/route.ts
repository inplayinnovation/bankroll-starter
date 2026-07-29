// Taking a charge, and listing the ones already taken.
//
// This is the receiving half of the money loop: the client calls
// `bankroll.charge()`, the host settles it on-chain, and the signature arrives
// here to be verified and recorded. The starter charges a flat $1 and pays the
// same $1 back so both directions are visible; a real app charges for something
// and keeps the money. The shape of this route is the part worth keeping.
import { requireIdentity, requireSession, Unauthorized } from '@joinbankroll/sdk/next';
import {
  ConfirmChargeError,
  confirmCharge,
  HSUSD_MINT,
  requireTreasury,
} from '@joinbankroll/sdk/server';

import { appTokenMints } from '@/lib/app-identity';
import { listCharges, recordCharge } from '@/lib/store';

// One amount, because the demo is about the money loop rather than a catalogue.
export const PRICE_CENTS = 100;

// A page of history; the client pages with the returned cursor.
const PAGE_SIZE = 20;

export async function GET(request: Request) {
  const session = await requireSession(request);
  const cursor = new URL(request.url).searchParams.get('cursor') ?? undefined;
  const page = await listCharges(session.user.wallet, { limit: PAGE_SIZE, cursor });
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

    // 2. Does it match what we expected? All four checks release value.
    //    The payee check is the one to never skip: any settled transfer passes
    //    the others, including one the user sent to their own second wallet.
    //    The mint check is the second: the signature comes from the client, so
    //    without it a token the sender minted themselves — worth nothing,
    //    costing them cents to create — would be paid back out in real HSUSD.
    //    Only HSUSD and this app's own tokens are ever accepted, and which one
    //    paid is recorded so the payout returns the same asset.
    const accepted = appTokenMints();
    if (charge.payee !== treasury.address) {
      return Response.json({ error: 'payment went to another address' }, { status: 400 });
    }
    if (charge.mint !== HSUSD_MINT && !accepted.includes(charge.mint)) {
      return Response.json({ error: 'payment was made in another asset' }, { status: 400 });
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
    const { created, charge: recorded } = await recordCharge(
      session.user.wallet,
      signature,
      charge.slot,
      charge.amountCents,
      charge.mint,
    );

    // A repeat is not a failure. A retried request and a replayed one look
    // identical, and both are already satisfied by the charge that exists.
    return Response.json({ charge: recorded }, { status: created ? 201 : 200 });
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
