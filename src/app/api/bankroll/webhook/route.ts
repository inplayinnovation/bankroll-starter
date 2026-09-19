import { bankrollWebhook } from '@joinbankroll/sdk/webhooks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Bankroll reports here on every managed reference this app mints and every
// timer it sets. The skeleton mints none; bind your game's `p2p.webhook` in
// place of these handlers, as recipes/p2p.md shows.
export const POST = bankrollWebhook({
  onConfirmed: () => undefined,
  onExpired: () => undefined,
  onFired: () => undefined,
});
