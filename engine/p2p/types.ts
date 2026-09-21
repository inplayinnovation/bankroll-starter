import type { ConfirmedCharge, PayRecipient, PaymentSigner } from '@joinbankroll/sdk/server';
import type { StoreBackend } from '@joinbankroll/sdk/store';

import type { BankrollPrimitives } from './bankroll';

export interface Actor {
  wallet: string;
}

export type Progress<State, Result> =
  | { status: 'running'; state: State; nextDeadlineAt?: number }
  | { status: 'finished'; state: State; result: Result };

export interface GameContext<Challenge> {
  challenge: Readonly<Challenge>;
  startedAt: number;
  endsAt: number;
  closesAt: number;
  /** Deadline events use their effective deadline, not webhook delivery time. */
  now: number;
}

export interface GameDefinition<Challenge, State, Action, Result, View> {
  id: string;
  version: number;
  durationMs: number;
  submissionGraceMs?: number;
  challenge(seed: string): Challenge;
  parseChallenge(value: unknown): Challenge;
  parseAction(value: unknown): Action;
  start(context: GameContext<Challenge>): Progress<State, Result>;
  step(
    state: Readonly<State>,
    event: { type: 'action'; action: Action } | { type: 'deadline' },
    context: GameContext<Challenge>,
  ): Progress<State, Result>;
  view(state: Readonly<State>, context: GameContext<Challenge>): View;
  compare(a: Readonly<Result>, b: Readonly<Result>): 'a' | 'b' | 'tie';
}

export interface Policy {
  entryCents: number;
  creatorFeeBps: number;
  startWindowMs: number;
  queueWindowMs: number;
}

export interface TreasuryTerms {
  payee: string;
  creatorWallet: string;
  mint: string;
}
export interface Treasury {
  terms(): TreasuryTerms;
  signer(attemptId: string): PaymentSigner;
}

export interface EngineOptions<C, S, A, R, V> {
  game: GameDefinition<C, S, A, R, V>;
  previousVersions?: GameDefinition<C, S, A, R, V>[];
  /** Server-approved prices/policies. Defaults to one offer named 'default'. */
  offers?: Readonly<Record<string, Partial<Policy>>>;
  store: StoreBackend;
  treasury: Treasury;
  origin(): string | Promise<string>;
  namespace?: string;
  /** Primitive/clock substitution for isolated tests. Normal apps omit these. */
  primitives?: BankrollPrimitives;
  now?: () => number;
  /** Operator methods deny access unless this server-side authorizer is supplied. */
  authorizeOperator?: (actor: Actor) => boolean | Promise<boolean>;
}

export interface PaymentRequest {
  amountCents: number;
  reference: string;
  memo: string;
  idempotencyKey: string;
  expiresAt: string;
}

export interface RoundView<View, Result> {
  id: string;
  gameId: string;
  version: number;
  createdAt: number;
  status:
    | 'initializing'
    | 'awaiting_payment'
    | 'ready'
    | 'playing'
    | 'finished'
    | 'forfeited'
    | 'cancelled'
    | 'needs_attention';
  sequence: number;
  entryCents: number;
  payment: PaymentRequest | null;
  paid: boolean;
  opponent: 'waiting' | 'matched' | 'cancelled';
  game: View | null;
  result: Result | null;
  deadlines: {
    queue: number | null;
    start: number | null;
    play: number | null;
    submission: number | null;
  };
  allowed: { start: boolean; act: boolean; cancel: boolean };
  outcome: { kind: 'win' | 'loss' | 'tie'; amountCents: number } | null;
  payout: {
    kind: 'prize' | 'refund';
    status: 'pending' | 'sent' | 'paid' | 'needs_attention';
    signature: string | null;
  } | null;
  issue: string | null;
}

export interface CommandAcknowledgement {
  id: string;
  sequence: number;
}
export interface CommandResult<View, Result> {
  command: CommandAcknowledgement;
  round: RoundView<View, Result>;
}

/** Core errors deliberately carry no HTTP status or framework response. */
export class EngineError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

export function defineGame<C, S, A, R, V>(
  definition: GameDefinition<C, S, A, R, V>,
): GameDefinition<C, S, A, R, V> {
  return definition;
}

/** Operator-only evidence, without signed transaction bytes or signer secrets. */
export interface PaymentInspection {
  id: string;
  payee: string;
  recipients: PayRecipient[];
  status: 'pending' | 'sent' | 'paid' | 'needs_attention';
  signature: string | null;
  issue: string | null;
  attempts: Array<{
    id: string;
    reference: string;
    mode: 'signed' | 'hosted';
    signature: string | null;
    expiresAt: string;
    lastValidBlockHeight: number | null;
    claimed: boolean;
  }>;
}
export interface OperatorInspection<View, Result> {
  round: RoundView<View, Result>;
  receipt: ConfirmedCharge | null;
  matchId: string | null;
  payment: PaymentInspection | null;
}
