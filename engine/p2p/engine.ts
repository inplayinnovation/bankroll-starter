import { createLifecycle } from './lifecycle';
import type { EngineReply, EngineRequest, RoundReply } from './protocol';
import {
  EngineError,
  type Actor,
  type EngineOptions,
  type OperatorInspection,
  type RoundSnapshot,
  type RoundView,
} from './types';
import { copy } from './util';

function request(value: unknown): EngineRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new EngineError('invalid_request');
  const input = copy(value) as Record<string, unknown>;
  const keys = (allowed: string[]) => {
    if (Object.keys(input).some((key) => !allowed.includes(key)))
      throw new EngineError('invalid_request');
  };
  const text = (key: string, maximum = 200): string => {
    const result = input[key];
    if (typeof result !== 'string' || !result.trim() || result.length > maximum)
      throw new EngineError('invalid_request');
    return result;
  };
  switch (input.type) {
    case 'play':
      keys(['type', 'commandId', 'offerId']);
      return {
        type: 'play',
        commandId: text('commandId'),
        ...(Object.hasOwn(input, 'offerId') ? { offerId: text('offerId') } : {}),
      };
    case 'resume':
    case 'get':
      keys(['type', 'roundId']);
      return { type: input.type, roundId: text('roundId') };
    case 'act':
      keys(['type', 'roundId', 'commandId', 'sequence', 'action']);
      if (
        !Object.hasOwn(input, 'action') ||
        !Number.isSafeInteger(input.sequence) ||
        Number(input.sequence) < 0
      )
        throw new EngineError('invalid_request');
      return {
        type: 'act',
        roundId: text('roundId'),
        commandId: text('commandId'),
        sequence: Number(input.sequence),
        action: input.action,
      };
    case 'history':
      keys(['type', 'cursor', 'limit']);
      if (
        Object.hasOwn(input, 'limit') &&
        (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 100)
      )
        throw new EngineError('invalid_request');
      return {
        type: 'history',
        ...(Object.hasOwn(input, 'cursor') ? { cursor: text('cursor', 8_192) } : {}),
        ...(Object.hasOwn(input, 'limit') ? { limit: Number(input.limit) } : {}),
      };
    default:
      throw new EngineError('invalid_request');
  }
}

function playerView<V, R>(snapshot: RoundSnapshot<V, R>): RoundView<V, R> {
  const { sequence, payment, allowed, status, ...round } = snapshot;
  // Keep transport-only fields out of player, history and operator projections.
  void sequence;
  void payment;
  return {
    ...round,
    status:
      status === 'initializing' || status === 'awaiting_payment' || status === 'ready'
        ? 'starting'
        : status,
    canAct: allowed.act,
  };
}

/** Owns the player workflow. Verified actor identity comes from the server binding. */
export function createP2PEngine<C, S, A, R, V>(options: EngineOptions<C, S, A, R, V>) {
  const lifecycle = createLifecycle(options);
  const reply = (snapshot: RoundSnapshot<V, R>): RoundReply<V, R> => ({
    kind: 'round',
    round: playerView(snapshot),
    sequence: snapshot.sequence,
    payment: snapshot.payment,
  });

  async function continuePlay(actor: Actor, snapshot: RoundSnapshot<V, R>) {
    if (snapshot.paid && snapshot.allowed.start) {
      try {
        snapshot = (
          await lifecycle.start(actor, {
            roundId: snapshot.id,
            commandId: `engine:start:${snapshot.id}`,
          })
        ).round;
      } catch (error) {
        // A real deadline can close the round between observation and the start write.
        if (
          !(error instanceof EngineError) ||
          !['round_closed', 'start_window_closed'].includes(error.code)
        )
          throw error;
        snapshot = await lifecycle.resumeExisting(actor, snapshot.id);
      }
    }
    return reply(snapshot);
  }

  async function handle(actor: Actor, value: unknown): Promise<EngineReply<V, R>> {
    const input = request(value);
    switch (input.type) {
      case 'play':
        return continuePlay(actor, (await lifecycle.enter(actor, input)).round);
      case 'resume':
        return continuePlay(actor, await lifecycle.resumeExisting(actor, input.roundId));
      case 'act':
        return reply((await lifecycle.act(actor, input)).round);
      case 'get':
        return reply(await lifecycle.get(actor, input.roundId));
      case 'history': {
        const page = await lifecycle.history(actor, input);
        return { kind: 'history', rounds: page.rounds.map(playerView), cursor: page.cursor };
      }
    }
  }

  return {
    handle,
    webhook: lifecycle.webhook,
    async inspect(
      actor: Actor,
      input: { wallet: string; roundId: string },
    ): Promise<OperatorInspection<V, R>> {
      const inspection = await lifecycle.inspect(actor, input);
      return { ...inspection, round: playerView(inspection.round) };
    },
    async reconcile(actor: Actor, input: { wallet: string; roundId: string }) {
      return playerView(await lifecycle.reconcile(actor, input));
    },
  };
}
