import type { Json, Ticket, TicketInput } from '@joinbankroll/sdk/matchmaking';
import type { PaymentSigner, PayRecipient } from '@joinbankroll/sdk/server';
import type { StoreBackend } from '@joinbankroll/sdk/store';

import type { Policy } from './rules';

export type TerminalReason = 'played' | 'expired' | 'forfeited';
export interface Terminal<Game> {
  game: Game;
  reason: TerminalReason;
}
export interface FinalRound<Game> {
  id: string;
  wallet: string;
  // Only the SDK's synthetic development opponent has no round document.
  game: Game | null;
  reason: TerminalReason;
}
export type Outcome = { kind: 'win' | 'forfeit'; winner: string } | { kind: 'tie'; winner: null };

/** The only game-specific behavior the mode calls. All hooks are pure. */
export interface GameHooks<Game, Conditions extends Json> {
  conditions: {
    /** Compatibility key: game/rules/limits, excluding the proposed random seed. */
    key: string;
    validate(payload: unknown): Conditions;
  };
  /** Null while playable. On expiry, return the final snapshot to persist in CAS. */
  terminal(game: Readonly<Game>, now: number): Terminal<Game> | null;
  outcome(a: Readonly<FinalRound<Game>>, b: Readonly<FinalRound<Game>>): Outcome;
}

export interface PaymentTerms {
  payee: string;
  creatorWallet: string;
  mint: string;
}
export interface EntryTerms extends PaymentTerms {
  entryCents: number;
  prizeCents: number;
  creatorFeeCents: number;
  startWindowMs: number;
  queue: string;
}
export interface Entry<Conditions extends Json> {
  status: 'ready' | 'started' | 'cancelled' | 'forfeited';
  startedAt: number | null;
  forfeitedAt: number | null;
  // The player's origin: what admission and Bankroll's app credential use.
  origin: string;
  terms: EntryTerms;
  payment: {
    /** A managed reference: Bankroll watches the chain for the charge carrying it. */
    reference: string;
    /** When Bankroll stops watching. An entry still unpaid then is over. */
    expiresAt: string;
    /** The idempotency key the client passes to charge(). */
    key: string;
    memo: string;
    /** The charge Bankroll reported, once checked against the terms. */
    signature: string | null;
  };
  conditions: Conditions;
  ticketInput: TicketInput<Conditions>;
  ticket: Ticket<Conditions> | null;
  cancelRequested: boolean;
}

/** One attempt to pay what a document owes. */
export interface PayoutAttempt {
  /** A managed reference on the transaction: Bankroll reports where it lands. */
  reference: string;
  /** When Bankroll stops watching; a fresh attempt is safe only after this. */
  expiresAt: string;
  idempotencyKey: string;
  startedAt: number;
  /** The bytes built for it, stored before the send, so a retry resends the same transaction. */
  transaction: string;
  /** What the send answered, if it answered before anything went wrong. */
  signature: string | null;
}
/** Money a document owes, paid by one transaction. */
export interface Payout {
  recipients: PayRecipient[];
  memo: string;
  status: 'pending' | 'sent' | 'paid';
  attempt: PayoutAttempt | null;
  /** The landed transaction, from Bankroll's `reference.confirmed`. */
  signature: string | null;
}

/** Game and entry share one CAS. Null entry means there is no paid admission. */
export interface Round<Game, Conditions extends Json> {
  schema: 1;
  kind: string;
  id: string;
  wallet: string;
  createdAt: number;
  game: Game;
  entry: Entry<Conditions> | null;
  // A cancelled paid entry's refund: the round document owes it.
  payout: Payout | null;
}
export type PaidRound<Game, Conditions extends Json> = Round<Game, Conditions> & {
  entry: Entry<Conditions>;
};

export interface Context<Game, Conditions extends Json> {
  hooks: GameHooks<Game, Conditions>;
  policy: Policy;
  store: StoreBackend;
  /** The signer for one payout attempt, by its idempotency key. */
  payoutSigner(idempotencyKey: string): PaymentSigner;
  paymentTerms(): PaymentTerms;
  /**
   * Set by createP2P on the player side only: pays what a round owes once a
   * transition or a read has left it owing, inline, before the request
   * answers. The settling side runs without it, so settling never triggers
   * settling.
   */
  settle?: (wallet: string, id: string, origin: string) => Promise<void>;
}
export interface MatchResult<Game> {
  id: string;
  // The origin the payout's managed reference is created under.
  origin: string;
  players: [FinalRound<Game>, FinalRound<Game>];
  outcome: Outcome;
  winner: string | null;
  entryCents: number;
  prizeCents: number;
  creatorFeeCents: number;
  payout: Payout;
}
