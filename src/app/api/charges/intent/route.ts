// Starting a charge: writing down what we are about to ask for, before asking.
//
// This exists so a payment can never go missing. `charge()` gives the signature
// to the page, and the page gives it to the server — but if the page dies in
// between, the payment still settled and nothing points to it. So the server
// mints a reference here and stores it first; the payment carries it on-chain,
// and the sweep on the next visit can find the charge by it.
//
// Both values are minted on the server on purpose. A reference the page invents
// is one the page can lose, reuse, or forget to send, and the same is true of
// the key that stops a retry charging twice.
import { requireIdentity, requireSession, Unauthorized } from '@joinbankroll/sdk/next';
import { createReference } from '@joinbankroll/sdk/server';

import { DEMO_ITEM, itemFor } from '@/lib/catalog';
import { CHARGE_EXPIRES_SECONDS } from '@/lib/sweep';
import { recordIntent } from '@/lib/store';

export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    requireIdentity(session);

    // The client names what it is buying; the catalog says what that costs.
    // A body-less request is the demo, so the original one-button loop still
    // works unchanged.
    const body = (await request.json().catch(() => ({}))) as { item?: string };
    const itemId = body.item ?? DEMO_ITEM;
    const item = itemFor(itemId);
    if (!item) return Response.json({ error: 'unknown item' }, { status: 400 });

    const intent = await recordIntent(
      session.user.wallet,
      createReference(),
      crypto.randomUUID(),
      item.amountCents,
      itemId,
    );

    // Everything the page needs to make the call, and nothing it decides. The
    // id comes back so the page can say which attempt it is reporting; losing
    // it costs nothing, since the sweep would find the charge anyway.
    return Response.json({
      id: intent.id,
      reference: intent.reference,
      paymentKey: intent.paymentKey,
      amountCents: intent.amountCents,
      expiresInSeconds: CHARGE_EXPIRES_SECONDS,
      item: itemId,
      name: item.name,
    });
  } catch (error) {
    if (error instanceof Unauthorized) {
      return Response.json({ error: error.message }, { status: 401 });
    }
    throw error;
  }
}
