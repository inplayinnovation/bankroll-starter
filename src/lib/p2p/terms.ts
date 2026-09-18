import { createHash } from 'node:crypto';

import { GameError } from '@/lib/game-error';

import type { Policy } from './rules';
import type { EntryTerms, PaymentTerms } from './types';

export function entryTerms(key: string, policy: Policy, payment: PaymentTerms): EntryTerms {
  const { entryCents, creatorFeeBps, startWindowMs } = policy;
  const creatorFeeCents = (entryCents * 2 * creatorFeeBps) / 10_000;
  const prizeCents = entryCents * 2 - creatorFeeCents;
  if (!payment.payee || !payment.creatorWallet || !payment.mint)
    throw new GameError('payments_not_configured', 503);
  if (
    !Number.isSafeInteger(entryCents) ||
    entryCents <= 0 ||
    !Number.isSafeInteger(creatorFeeBps) ||
    creatorFeeBps < 0 ||
    creatorFeeBps >= 10_000 ||
    !Number.isSafeInteger(creatorFeeCents) ||
    !Number.isSafeInteger(prizeCents) ||
    prizeCents <= 0 ||
    !Number.isSafeInteger(startWindowMs) ||
    startWindowMs <= 0
  )
    throw new GameError('invalid_entry_price', 503);

  const terms = { ...payment, entryCents, prizeCents, creatorFeeCents, startWindowMs };
  // Proposed randomness is intentionally absent: different proposals must pair.
  // Rules, limits, money, and no-show policy must agree before two tickets meet.
  const digest = createHash('sha256')
    .update(JSON.stringify({ key, ...terms }))
    .digest('hex')
    .slice(0, 24);
  return { ...terms, queue: `p2p:${digest}` };
}
