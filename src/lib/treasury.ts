// The treasury: the app's one secret.
//
// BANKROLL_TREASURY_KEY is a base58 Solana secret key. `npm run bankroll`
// generates one for development on first run; a deployment gets its OWN key,
// stored on Vercel as a *sensitive* variable — unreadable afterwards, by anyone
// including you. Without it the app runs fine; it just can't take or send
// money, and says so in its manifest.
import { keypairSigner, type PaymentSigner } from '@joinbankroll/sdk/server';

let cached: PaymentSigner | null | undefined;

export function treasurySigner(): PaymentSigner | null {
  if (cached !== undefined) return cached;
  const secretKey = process.env.BANKROLL_TREASURY_KEY;
  cached = secretKey ? keypairSigner(secretKey) : null;
  return cached;
}

/**
 * The treasury's public address, or null when unconfigured. Derived from the
 * secret key, so the payment address the manifest advertises can never drift
 * from the wallet that actually signs.
 */
export function treasuryAddress(): string | null {
  return treasurySigner()?.address ?? null;
}

/** Fails with the setup instruction rather than a cryptic decode error. */
export function requireTreasury(): PaymentSigner {
  const signer = treasurySigner();
  if (!signer) {
    throw new Error('No treasury — set BANKROLL_TREASURY_KEY (see /setup)');
  }
  return signer;
}
