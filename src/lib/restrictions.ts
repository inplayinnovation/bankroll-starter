// Where, and from what age, this app takes real money: the policy in
// BANKROLL_RESTRICTIONS, evaluated against the verified session. Bankroll
// sets the policy on a builder app; an unset policy means no restriction.
// Pass the session from getSession(), never a location or an age the browser
// supplied.
import {
  restrictionFor,
  restrictionPolicyFromEnv,
  type Restriction,
} from '@joinbankroll/sdk/restrictions';
import type { BankrollSession } from '@joinbankroll/sdk/server';

export type { Restriction, RestrictionReason } from '@joinbankroll/sdk/restrictions';

/**
 * A null `reason` means the session may pay. Otherwise it says why not, for
 * the server to refuse with and the UI to explain.
 */
export function paidPlayRestriction(session: BankrollSession): Restriction {
  return restrictionFor(session, restrictionPolicyFromEnv());
}
