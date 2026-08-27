// Turning a settled payment into a recorded charge.
//
// Two paths arrive here: the live one, where the page hands back the signature,
// and the sweep, where the page never got to and the payment was found on-chain
// by its reference. They must agree about what a valid payment is, so the checks
// live here once rather than in both.
//
// They converge on one document by construction. The charge's id is derived from
// the transaction, so the sweep computes the same id as the live path and the
// single atomic create in `recordCharge` collapses them — no lock, no claim
// flag, no "already being recovered" state.
import { HSUSD_MINT, requireTreasury, type ConfirmedCharge } from '@joinbankroll/sdk/server';

import { appTokenMints } from '@/lib/app-identity';
import { recordCharge, type Charge } from '@/lib/store';

/**
 * The amount this app charges. One price, because the demo is the money loop
 * rather than a catalogue — and the smallest real one, because every charge
 * here moves actual money. A cent is enough to watch it move.
 */
export const PRICE_CENTS = 1;

/** Why a settled payment was refused — none of these are retryable. */
export type RejectedReason =
  | 'payment went to another address'
  | 'payment was made in another asset'
  | 'payment amount does not match'
  | 'payment came from another wallet';

export type SettleResult =
  { ok: true; created: boolean; charge: Charge } | { ok: false; reason: RejectedReason };

/**
 * Check a settled payment against what this app expected, and record it.
 *
 * All four checks release value, and the `payee` one is never skippable: a
 * settled transfer of the right amount from the right wallet to *any other
 * address the user controls* passes the rest. The `mint` check is the second,
 * because the payment is identified by a client-supplied signature — without it
 * a token the sender minted themselves, worth nothing, would be accepted and
 * later paid back out in real money.
 *
 * Finding a payment by its reference proves nothing about it either. The chain
 * indexes every address a transaction touches, and a reference is public once it
 * lands, so anyone can attach one to a transfer of their own — a swept charge
 * gets exactly the same scrutiny as one the page reported.
 */
export async function settle(wallet: string, charge: ConfirmedCharge): Promise<SettleResult> {
  const treasury = requireTreasury();
  const accepted = appTokenMints();

  if (charge.payee !== treasury.address)
    return { ok: false, reason: 'payment went to another address' };
  if (charge.mint !== HSUSD_MINT && !accepted.includes(charge.mint)) {
    return { ok: false, reason: 'payment was made in another asset' };
  }
  if (charge.amountCents !== PRICE_CENTS)
    return { ok: false, reason: 'payment amount does not match' };
  if (charge.payer !== wallet) return { ok: false, reason: 'payment came from another wallet' };

  const { created, charge: recorded } = await recordCharge(
    wallet,
    charge.signature,
    charge.slot,
    charge.amountCents,
    charge.mint,
  );
  return { ok: true, created, charge: recorded };
}
