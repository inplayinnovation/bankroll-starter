import type { Json, Match, Ticket, TicketInput } from '@joinbankroll/sdk/matchmaking';
import type { ConfirmedCharge, PayRecipient } from '@joinbankroll/sdk/server';

import type { PreparedPayout } from './bankroll';
import type { PaymentRequest, Policy, TreasuryTerms } from './types';

export type Purpose = 'queue' | 'no-show' | 'game';
export interface TimerSlot {
  token: string;
  id: string;
  at: string;
  dueAt: number;
}
export interface Terms extends TreasuryTerms, Policy {
  offerId: string;
  queue: string;
  prizeCents: number;
  creatorFeeCents: number;
}
export interface Attempt extends PreparedPayout {
  expiresAt: string;
  claim: string | null;
}
export interface Payout {
  id: string;
  payee: string;
  recipients: PayRecipient[];
  memo: string;
  status: 'pending' | 'sent' | 'paid' | 'needs_attention';
  attempt: Attempt;
  retired: Attempt[];
  signature: string | null;
  issue: string | null;
}
export interface CommandReceipt {
  fingerprint: string;
  sequence: number;
  acceptedAt: number;
}

export interface Round<C, S, R> {
  schema: 1;
  kind: 'round';
  revision: number;
  id: string;
  wallet: string;
  origin: string;
  createdAt: number;
  gameId: string;
  version: number;
  terms: Terms;
  challenge: C;
  payment: (PaymentRequest & { signature: string | null }) | null;
  receipt: ConfirmedCharge | null;
  paymentRejected: boolean;
  queueExpiresAt: number | null;
  ticketInput: TicketInput<Json> | null;
  ticket: Ticket<Json> | null;
  cancelRequested: boolean;
  cancelled: boolean;
  play: {
    state: S;
    startedAt: number;
    endsAt: number;
    closesAt: number;
    nextDeadlineAt: number;
  } | null;
  finish: { reason: 'played' | 'timeout' | 'forfeit'; result: R | null } | null;
  sequence: number;
  commands: Record<string, CommandReceipt>;
  timers: Partial<Record<Purpose, TimerSlot>>;
  payout: Payout | null;
  issue: string | null;
}

export interface MatchDocument {
  schema: 1;
  kind: 'match';
  revision: number;
  id: string;
  origin: string;
  gameId: string;
  version: number;
  match: Match<Json>;
  terms: Terms;
  outcome: { kind: 'win' | 'tie'; winner: string | null } | null;
  payout: Payout | null;
  issue: string | null;
  timers: Partial<Record<Purpose, TimerSlot>>;
}

export interface EventMeta {
  engine: string;
  kind: 'payin' | 'payout' | 'deadline';
  path: string;
  token: string;
  baseRevision: number;
  purpose?: Purpose;
}
