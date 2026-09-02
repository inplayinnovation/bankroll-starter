// Taking a charge, and listing the ones already taken.
//
// This is the receiving half of the money loop: the client calls
// `bankroll.charge()`, the host settles it on-chain, and the signature arrives
// here to be verified and recorded. The starter charges a cent and pays the
// same cent back so both directions are visible; a real app charges for
// something and keeps the money. The shape of this route is the part worth
// keeping.
//
// What the checks are and why lives in lib/charges.ts, because the sweep needs
// exactly the same ones — a payment found on-chain is no more trustworthy than
// one the page reported.
import { requireIdentity, requireSession, Unauthorized } from '@joinbankroll/sdk/next';
import { ConfirmChargeError, confirmCharge } from '@joinbankroll/sdk/server';

import { settle } from '@/lib/charges';
import { closeIntent, getIntent, listCharges } from '@/lib/store';
import { sweep } from '@/lib/sweep';

export { PRICE_CENTS } from '@/lib/charges';

// A page of history; the client pages with the returned cursor.
const PAGE_SIZE = 20;

export async function GET(request: Request) {
  const session = await requireSession(request);
  const cursor = new URL(request.url).searchParams.get('cursor') ?? undefined;

  // Before showing someone their charges, catch any that settled without ever
  // being reported — the app being reopened is exactly when that is worth
  // checking, and the recovered charge then appears in this same response.
  // Only on the first page: paging back through history is not a new visit.
  if (!cursor) await sweep(session.user.wallet);

  const page = await listCharges(session.user.wallet, { limit: PAGE_SIZE, cursor });
  return Response.json(page);
}

export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    requireIdentity(session);

    const { signature, intentId } = (await request.json()) as {
      signature?: string;
      intentId?: string;
    };
    if (!signature) return Response.json({ error: 'signature is required' }, { status: 400 });

    // What actually settled on-chain? A return value means it settled.
    const confirmed = await confirmCharge(signature);

    // What was asked for, from the server's own note — never from the body.
    // No intent means the demo's single price.
    const intent = intentId ? await getIntent(session.user.wallet, intentId) : null;
    const result = await settle(
      session.user.wallet,
      confirmed,
      intent
        ? { amountCents: intent.amountCents, ...(intent.item ? { item: intent.item } : {}) }
        : undefined,
    );
    if (!result.ok) return Response.json({ error: result.reason }, { status: 400 });

    // The attempt behind this charge is answered, so the sweep can stop asking
    // the chain about it. Only an optimisation — an intent left open ages out
    // of the sweep's window by itself.
    if (intentId) await closeIntent(session.user.wallet, intentId, 'recorded');

    // A repeat is not a failure. A retried request and a replayed one look
    // identical, and both are already satisfied by the charge that exists.
    return Response.json({ charge: result.charge }, { status: result.created ? 201 : 200 });
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
