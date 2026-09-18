import type { Json, Ticket, TicketInput } from '@joinbankroll/sdk/matchmaking';
import type { Payout, SettlePayoutOptions } from '@joinbankroll/sdk/server';

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
  // Cron may arrive on a deployment URL; admission uses the player's origin.
  origin?: string;
  terms: EntryTerms;
  payment: {
    reference: string;
    key: string;
    memo: string;
    offeredUntil: number;
    signature: string | null;
  };
  conditions: Conditions;
  ticketInput: TicketInput<Conditions>;
  ticket: Ticket<Conditions> | null;
  cancelRequested: boolean;
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
  // The SDK settles a root `payout` field; refunds stay on this same document.
  payout: Payout | null;
}
export type PaidRound<Game, Conditions extends Json> = Round<Game, Conditions> & {
  entry: Entry<Conditions>;
};

export interface Context<Game, Conditions extends Json> extends SettlePayoutOptions {
  hooks: GameHooks<Game, Conditions>;
  policy: Policy;
  paymentTerms(): PaymentTerms;
  /**
   * Runs work after the current response has been sent — Next's `after` from
   * 'next/server' in a route handler. When set, a transition that leaves a
   * round owing money schedules its settlement right away, in the background
   * of the request that made it; the scheduled worker remains the backstop.
   */
  after?: (work: () => Promise<unknown>) => void;
  /** Set by createP2P on the player side only: schedules the worker for one round. */
  settleLater?: (wallet: string, id: string, origin: string) => void;
}
export interface MatchResult<Game> {
  id: string;
  players: [FinalRound<Game>, FinalRound<Game>];
  outcome: Outcome;
  winner: string | null;
  entryCents: number;
  prizeCents: number;
  creatorFeeCents: number;
  payout: Payout;
}
