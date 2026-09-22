import type { PaymentRequest, RoundView } from './types';

/** Private client/server transport. Apps call the engine client rather than assemble these steps. */
export type EngineRequest =
  | { type: 'play'; commandId: string; offerId?: string }
  | { type: 'resume'; roundId: string }
  | { type: 'act'; roundId: string; commandId: string; sequence: number; action: unknown }
  | { type: 'get'; roundId: string }
  | { type: 'history'; cursor?: string; limit?: number };

export interface RoundReply<View, Result> {
  kind: 'round';
  round: RoundView<View, Result>;
  sequence: number;
  payment: PaymentRequest | null;
}

export type EngineReply<View, Result> =
  | RoundReply<View, Result>
  | { kind: 'history'; rounds: RoundView<View, Result>[]; cursor: string | null };
