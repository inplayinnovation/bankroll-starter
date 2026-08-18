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

import { PRICE_CENTS } from '@/lib/charges';
import { CHARGE_EXPIRES_SECONDS } from '@/lib/sweep';
import { recordIntent } from '@/lib/store';

export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    requireIdentity(session);

    const intent = await recordIntent(
      session.user.wallet,
      createReference(),
      crypto.randomUUID(),
      PRICE_CENTS,
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
    });
  } catch (error) {
    if (error instanceof Unauthorized) {
      return Response.json({ error: error.message }, { status: 401 });
    }
    throw error;
  }
}
