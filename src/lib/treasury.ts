// The wallet this app takes money into and pays out of. Three shapes, and
// this file is the one place that says which one a deployment is:
//
// 1. A Bankroll server wallet — what the in-app builder gives an app, and
//    what `bankroll-admin server-wallet:create` provisions for a self-hosted
//    one. A Privy wallet Bankroll created for this app, owned by its creator,
//    with this app's key as its only signer under a payout policy. The app
//    never holds the wallet's key: BANKROLL_DELEGATED_KEY signs payout
//    REQUESTS, which Bankroll relays to the wallet. Provisioning prints
//    BANKROLL_PAYEE, BANKROLL_DELEGATED_KEY, BANKROLL_DELEGATED_WALLET_ID,
//    BANKROLL_PRIVY_APP_ID and BANKROLL_OWNER.
// 2. A keypair — BANKROLL_TREASURY_KEY, a base58 Solana secret key the app
//    signs with itself. What `npm run dev` gives you.
// 3. Charge-only — BANKROLL_PAYEE alone names a wallet the app can receive at
//    and cannot pay out of.
import {
  delegatedPrivySigner,
  requireTreasury,
  treasuryAddress,
  type PaymentSigner,
} from '@joinbankroll/sdk/server';

/** True when the deployment has a Bankroll server wallet. */
export const serverWalletConfigured = (): boolean => Boolean(process.env.BANKROLL_DELEGATED_KEY);

/**
 * Where charges settle, and the address every settled payment is checked
 * against before value is released. Null when nothing is configured.
 */
export const payeeAddress = (): string | null =>
  serverWalletConfigured()
    ? process.env.BANKROLL_PAYEE || null
    : (treasuryAddress() ?? process.env.BANKROLL_PAYEE ?? null);

/**
 * The owner: the person the admin screen belongs to. The server wallet's
 * owner for shape 1, the keypair's own address for shape 2, the payee for
 * charge-only, where the payee IS the creator's wallet.
 */
export const ownerAddress = (): string | null =>
  process.env.BANKROLL_OWNER || (serverWalletConfigured() ? null : payeeAddress());

/** Payouts need something that can sign, not just an address. */
export const payoutsAvailable = (): boolean =>
  serverWalletConfigured() || treasuryAddress() !== null;

/**
 * The signer for one payout attempt. The idempotency key names the attempt
 * to a server wallet, which dedupes it for 24h: resending the same bytes
 * under the same key resolves to the original signature, never a second
 * transfer. A keypair ignores it; its signatures are deterministic anyway.
 */
export const payoutSigner = (idempotencyKey: string): PaymentSigner =>
  serverWalletConfigured() ? delegatedPrivySigner({ idempotencyKey }) : requireTreasury();
