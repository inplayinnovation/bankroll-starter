// The wallet this app takes money into and pays out of. Two shapes, and this
// file is the one place that says which one a deployment is:
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
import { mockEnabled, mockPayoutSigner } from '@joinbankroll/sdk/mock';
import {
  delegatedPrivySigner,
  requireTreasury,
  treasuryAddress,
  type PaymentSigner,
} from '@joinbankroll/sdk/server';

/**
 * True when the deployment has a Bankroll server wallet. Keyed on the wallet
 * id, not the key: a coding agent's dev server has the id and the payee but
 * never the key, and must still know that payouts are part of this app.
 */
export const serverWalletConfigured = (): boolean => Boolean(process.env.BANKROLL_DELEGATED_WALLET_ID);

/**
 * Where charges settle, and the address every settled payment is checked
 * against before value is released. Null when nothing is configured.
 */
export const payeeAddress = (): string | null =>
  serverWalletConfigured() ? process.env.BANKROLL_PAYEE || null : treasuryAddress();

/**
 * The owner: the person the admin screen belongs to. The server wallet's
 * owner for shape 1; the keypair's own address for shape 2.
 */
export const ownerAddress = (): string | null => process.env.BANKROLL_OWNER || treasuryAddress();

/**
 * The signer for one payout attempt. The idempotency key names the attempt
 * to a server wallet, which dedupes it for 24h: resending the same bytes
 * under the same key resolves to the original signature, never a second
 * transfer. A keypair ignores it; its signatures are deterministic anyway.
 *
 * Under the mock (BANKROLL_MOCK=1 outside production — a coding agent's dev
 * server, `npm run check`) payouts are simulated the way charges are: the
 * signer answers with a made-up signature and no money moves.
 */
export function payoutSigner(idempotencyKey: string): PaymentSigner {
  if (mockEnabled()) return mockPayoutSigner(payeeAddress() ?? '');
  return serverWalletConfigured() ? delegatedPrivySigner({ idempotencyKey }) : requireTreasury();
}
