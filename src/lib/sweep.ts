// Finding the charges that never made it back.
//
// The happy path is the page handing you a signature. This is what happens when
// it can't: the app was killed, the connection dropped, the phone died between
// the payment settling and the fetch that would have reported it. The money
// moved and nothing this app holds points to it.
//
// The fix is that the app wrote down a reference *before* asking for the money,
// and the payment carries it on-chain. So the charge stays findable by an id
// that existed before it did.
import { ConfirmChargeError, findChargeByReference } from '@joinbankroll/sdk/server';

import { settle } from '@/lib/charges';
import { listRecentIntents, resolveIntent } from '@/lib/store';

/**
 * How long the user gets to approve. Every Bankroll charge expires; this only
 * says when. Keep it comfortable — the countdown is on screen, and there is
 * nothing to gain from rushing someone reading what they are paying for.
 */
export const CHARGE_EXPIRES_SECONDS = 90;

// How long after a charge could last have been approved it might still land: a
// signed transaction dies with the blockhash it was built on, plus room for the
// RPC's index to catch up. Past this an unfound payment was never made.
const SETTLEMENT_SLACK_MS = 3 * 60 * 1000;

/** The window worth asking the chain about — everything older has settled or died. */
export const LOOKBACK_MS = CHARGE_EXPIRES_SECONDS * 1000 + SETTLEMENT_SLACK_MS;

/**
 * Record any charge that settled without being reported, and return how many.
 *
 * Cheap by construction: it reads only the attempts from the last few minutes,
 * and asks the chain only about those still unresolved — so the usual case,
 * where every recent charge already came back through the page, costs one
 * listing and no network at all.
 *
 * Never throws. This runs on the way to showing someone their charges, and a
 * chain that cannot be read right now is a reason to show what is known, not to
 * fail the page. The intent stays open and the next visit tries again.
 */
export async function sweep(wallet: string): Promise<number> {
  let recovered = 0;

  for (const intent of await listRecentIntents(wallet, LOOKBACK_MS)) {
    if (intent.resolved) continue;
    try {
      const charge = await findChargeByReference(intent.reference);
      // Not there yet — and possibly never. Either way the intent ages out of
      // the window on its own; nothing needs to mark it dead.
      if (!charge) continue;

      const result = await settle(wallet, charge);
      if (result.ok) {
        await resolveIntent(wallet, intent.id);
        if (result.created) recovered += 1;
      }
    } catch (error) {
      // A payment that failed on-chain or was never a payment is settled news:
      // stop asking about it. Anything else — an unreachable RPC most likely —
      // is a failure to look, which must never read as a failure to find.
      if (error instanceof ConfirmChargeError && error.code !== 'rpc_error') {
        await resolveIntent(wallet, intent.id);
        continue;
      }
      return recovered;
    }
  }

  return recovered;
}
