import { bankrollWebhook } from '@joinbankroll/sdk/webhooks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Bankroll reports here on every managed reference this app mints and every
// timer it sets. The skeleton mints none; bind the configured engine's
// `webhook` in place of these handlers, as engine/p2p/README.md shows.
export const POST = bankrollWebhook({
  onConfirmed: () => undefined,
  onExpired: () => undefined,
  onFired: () => undefined,
});
