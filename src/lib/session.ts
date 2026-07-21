// Server-side identity. The Bankroll app sends a signed session token on every
// request; verifying it is the only thing that proves who the caller is —
// never trust a wallet address sent in a request body.
import { BANKROLL_TOKEN_HEADER } from '@joinbankroll/sdk';
import { verifyToken, type BankrollSession } from '@joinbankroll/sdk/server';

import { getOrigin } from './origin';

/** The verified session, or null when the token is missing or invalid. */
export async function getSession(request: Request): Promise<BankrollSession | null> {
  return verifyToken(request.headers.get(BANKROLL_TOKEN_HEADER), {
    // The token is minted for this exact origin, so a token issued for some
    // other app can't be replayed here.
    audience: await getOrigin(),
  });
}

export class Unauthorized extends Error {
  constructor() {
    super('a valid Bankroll session is required');
    this.name = 'Unauthorized';
  }
}

export async function requireSession(request: Request): Promise<BankrollSession> {
  const session = await getSession(request);
  if (!session) throw new Unauthorized();
  return session;
}

/**
 * Real money moves only for a verified identity. `identity` is truthy exactly
 * when the user has verified one real identity — gate every paid action on it.
 */
export function requireIdentity(session: BankrollSession): void {
  if (!session.user.identity) {
    throw new Error('identity verification is required for this action');
  }
}
