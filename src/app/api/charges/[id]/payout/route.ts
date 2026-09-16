// A player asking for what they are owed.
//
// The lifecycle itself lives in lib/payout.ts, so that anything else that
// settles charges (a sweep, a cron) pays under the same rules. What is left
// here is the part that is genuinely about a request: who is asking, and how
// each outcome reads as HTTP.
import { requireIdentity, requireSession, Unauthorized } from '@joinbankroll/sdk/next';

import { NotPayable, PayoutChargeNotFound, settlePayout } from '@/lib/payout';
import { payoutsAvailable } from '@/lib/treasury';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    // Charge-only mode: BANKROLL_PAYEE names where money arrives, and nothing
    // here can sign a transfer out of it.
    if (!payoutsAvailable()) {
      return Response.json(
        { error: 'payouts are not available: this app has nothing that can sign' },
        { status: 501 },
      );
    }
    const session = await requireSession(request);
    requireIdentity(session);
    const { id } = await params;

    const outcome = await settlePayout(session.user.wallet, id);
    if (outcome.state === 'pending') {
      return Response.json({ charge: outcome.charge, pending: true }, { status: 202 });
    }
    return Response.json({ charge: outcome.charge });
  } catch (error) {
    if (error instanceof Unauthorized) {
      return Response.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof PayoutChargeNotFound) {
      return Response.json({ error: 'charge not found' }, { status: 404 });
    }
    if (error instanceof NotPayable) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
