import { bankroll } from '@joinbankroll/sdk';
import { bankrollFetch } from '@joinbankroll/sdk/react';

import type { EngineReply, EngineRequest, RoundReply } from './protocol';
import { EngineError, type PaymentRequest, type RoundView } from './types';

export interface P2PSnapshot<V, R> {
  phase: 'idle' | 'starting' | 'playing' | 'finished' | 'error';
  round: RoundView<V, R> | null;
  error: { code: string; message: string } | null;
}
export interface P2PClientOptions {
  endpoint: string;
  /** Defaults to sessionStorage. Substitute an isolated store in tests. */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  storageKey?: string;
  /** Normal apps use the Bankroll authenticated transport and payment sheet. */
  fetch?: typeof fetch;
  charge?: (payment: PaymentRequest) => Promise<unknown>;
  pollIntervalMs?: number;
  confirmationTimeoutMs?: number;
  requestTimeoutMs?: number;
}
export interface P2PClient<V, R> {
  play(input?: { offerId?: string }): Promise<RoundView<V, R>>;
  resume(roundId?: string): Promise<RoundView<V, R>>;
  act(action: unknown): Promise<RoundView<V, R>>;
  get(roundId: string): Promise<RoundView<V, R>>;
  history(input?: {
    cursor?: string;
    limit?: number;
  }): Promise<{ rounds: RoundView<V, R>[]; cursor: string | null }>;
  subscribe(listener: () => void): () => void;
  getSnapshot(): P2PSnapshot<V, R>;
  dispose(): void;
}

type Intent = {
  version: 1;
  commandId: string;
  offerId: string;
  roundId: string | null;
  charge: 'new' | 'requested' | 'confirmed';
  pending: Extract<EngineRequest, { type: 'act' }> | null;
};
class TransportError extends EngineError {
  constructor(
    code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(code, message);
  }
}
const terminal = <V, R>(round: RoundView<V, R>) =>
  round.status !== 'starting' && round.status !== 'playing';
const settled = <V, R>(round: RoundView<V, R>) =>
  round.status === 'needs_attention' ||
  (round.status === 'cancelled' &&
    (!round.paid ||
      round.payout?.status === 'paid' ||
      round.payout?.status === 'needs_attention')) ||
  (Boolean(round.outcome) &&
    (round.payout?.status === 'paid' || round.payout?.status === 'needs_attention'));

/** The complete player workflow. UI code never coordinates payment and start. */
export function createP2PClient<V, R>(options: P2PClientOptions): P2PClient<V, R> {
  if (!options.endpoint) throw new EngineError('invalid_endpoint');
  const pollMs = options.pollIntervalMs ?? 1_000;
  const confirmationMs = options.confirmationTimeoutMs ?? 120_000;
  const requestMs = options.requestTimeoutMs ?? 20_000;
  if (
    [pollMs, confirmationMs, requestMs].some((value) => !Number.isSafeInteger(value) || value <= 0)
  )
    throw new EngineError('invalid_client_configuration');
  const fetcher = options.fetch ?? bankrollFetch;
  const charge =
    options.charge ??
    ((payment) =>
      bankroll.charge({
        amountCents: payment.amountCents,
        memo: payment.memo,
        reference: payment.reference,
        idempotencyKey: payment.idempotencyKey,
      }));
  const storageKey = options.storageKey ?? `bankroll:p2p:${options.endpoint}:v1`;
  const life = new AbortController();
  const listeners = new Set<() => void>();
  let snapshot: P2PSnapshot<V, R> = { phase: 'idle', round: null, error: null };
  let intent: Intent | null | undefined;
  let current: RoundReply<V, R> | null = null;
  let operation: Promise<RoundView<V, R>> | null = null;
  let operationKey: string | null = null;
  let watchTimer: ReturnType<typeof setTimeout> | undefined;
  let watchGeneration = 0;

  function storage() {
    if (options.storage) return options.storage;
    if (typeof window === 'undefined') throw new EngineError('browser_required');
    return window.sessionStorage;
  }
  function alive() {
    if (life.signal.aborted) throw new EngineError('disposed');
  }
  function load(): Intent | null {
    if (intent !== undefined) return intent;
    const raw = storage().getItem(storageKey);
    if (!raw) return (intent = null);
    try {
      const value = JSON.parse(raw) as Intent;
      if (
        value.version !== 1 ||
        typeof value.commandId !== 'string' ||
        typeof value.offerId !== 'string' ||
        !(value.roundId === null || typeof value.roundId === 'string') ||
        !['new', 'requested', 'confirmed'].includes(value.charge) ||
        !(value.pending === null || value.pending?.type === 'act')
      )
        throw new Error('Invalid stored intent');
      return (intent = value);
    } catch {
      throw new EngineError(
        'invalid_saved_play',
        'Saved play could not be read; keep its data for recovery.',
      );
    }
  }
  function save(value: Intent) {
    alive();
    // Fail before issuing a new charge/command if its identity cannot be retained.
    storage().setItem(storageKey, JSON.stringify(value));
    intent = value;
  }
  function publish(next: P2PSnapshot<V, R>) {
    if (life.signal.aborted) return;
    snapshot = next;
    listeners.forEach((listener) => listener());
  }
  function accept(reply: RoundReply<V, R>, starting = false) {
    alive();
    current = reply;
    const round = reply.round;
    publish({
      phase:
        starting && !terminal(round)
          ? 'starting'
          : round.status === 'starting'
            ? 'starting'
            : round.status === 'playing'
              ? 'playing'
              : 'finished',
      round,
      error: null,
    });
  }
  function aborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () =>
        reject(new EngineError(life.signal.aborted ? 'disposed' : 'request_timeout'));
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  async function delay(ms: number) {
    alive();
    let timer: ReturnType<typeof setTimeout>;
    try {
      await aborted(
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
        life.signal,
      );
    } finally {
      clearTimeout(timer!);
    }
  }
  async function request(input: EngineRequest): Promise<EngineReply<V, R>> {
    alive();
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const stop = () => controller.abort();
      life.signal.addEventListener('abort', stop, { once: true });
      const timer = setTimeout(stop, requestMs);
      try {
        return await aborted(
          (async () => {
            const response = await fetcher(options.endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(input),
              signal: controller.signal,
              cache: 'no-store',
            });
            const data = await response.json();
            if (!response.ok)
              throw new TransportError(
                data.error?.code ?? 'unavailable',
                data.error?.message ?? 'The game could not be reached.',
                response.status >= 500 || response.status === 429,
              );
            if (!data || (data.kind !== 'round' && data.kind !== 'history'))
              throw new Error('Invalid engine response');
            return data as EngineReply<V, R>;
          })(),
          controller.signal,
        );
      } catch (error) {
        alive();
        if ((error instanceof TransportError && !error.retryable) || attempt >= 2) throw error;
      } finally {
        clearTimeout(timer);
        life.signal.removeEventListener('abort', stop);
      }
      await delay(250 * (attempt + 1));
    }
  }
  async function roundRequest(input: EngineRequest): Promise<RoundReply<V, R>> {
    const value = await request(input);
    if (value.kind !== 'round') throw new EngineError('invalid_response');
    return value;
  }
  async function requestPlay(value: Intent): Promise<RoundReply<V, R>> {
    save(value);
    try {
      return await roundRequest({
        type: 'play',
        commandId: value.commandId,
        offerId: value.offerId,
      });
    } catch (error) {
      // These rejections happen before entry creation. An invalid offer must
      // not trap the player in an intent the server can never accept.
      if (
        error instanceof TransportError &&
        ['unknown_offer', 'invalid_request'].includes(error.code)
      ) {
        storage().removeItem(storageKey);
        intent = null;
      }
      throw error;
    }
  }
  function stopWatch() {
    watchGeneration++;
    clearTimeout(watchTimer);
    watchTimer = undefined;
  }
  function watch() {
    stopWatch();
    if (!current || settled(current.round) || life.signal.aborted) return;
    const generation = watchGeneration;
    const roundId = current.round.id;
    watchTimer = setTimeout(async () => {
      watchTimer = undefined;
      try {
        const reply = await roundRequest({ type: 'get', roundId });
        if (generation !== watchGeneration || life.signal.aborted) return;
        accept(reply);
      } catch (error) {
        if (generation !== watchGeneration || life.signal.aborted) return;
        publish({
          ...snapshot,
          error: {
            code: 'disconnected',
            message: error instanceof Error ? error.message : 'The game could not be reached.',
          },
        });
      }
      if (generation === watchGeneration && !life.signal.aborted) watch();
    }, pollMs);
  }
  function run(key: string, work: () => Promise<RoundView<V, R>>): Promise<RoundView<V, R>> {
    try {
      alive();
    } catch (error) {
      return Promise.reject(error);
    }
    if (operation)
      return operationKey === key
        ? operation
        : Promise.reject(new EngineError('operation_in_progress'));
    stopWatch();
    operationKey = key;
    // Schedule work after installing the in-flight identity (including reentrant subscribers).
    operation = Promise.resolve()
      .then(work)
      .catch((error) => {
        const rejectedAction =
          key.startsWith('act:') &&
          error instanceof TransportError &&
          !error.retryable &&
          snapshot.round &&
          snapshot.round.status !== 'starting';
        if (!life.signal.aborted)
          publish({
            ...snapshot,
            phase: rejectedAction
              ? snapshot.round!.status === 'playing'
                ? 'playing'
                : 'finished'
              : 'error',
            error: {
              code:
                error instanceof EngineError
                  ? error.code
                  : typeof error?.code === 'string'
                    ? error.code
                    : 'unavailable',
              message:
                error instanceof Error
                  ? error.message
                  : 'The operation could not be completed. Resume to continue.',
            },
          });
        if (rejectedAction) watch();
        throw error;
      })
      .finally(() => {
        operation = null;
        operationKey = null;
      });
    return operation;
  }
  async function replayPending(value: Intent): Promise<RoundReply<V, R> | null> {
    if (!value.pending) return null;
    let reply: RoundReply<V, R>;
    try {
      reply = await roundRequest(value.pending);
    } catch (error) {
      if (!(error instanceof TransportError) || error.retryable) throw error;
      // A definitive rejection ends that command. Recover the latest state
      // instead of poisoning later reconnects with an impossible replay.
      save({ ...value, pending: null });
      reply = await roundRequest({ type: 'get', roundId: value.pending.roundId });
      accept(reply);
      return reply;
    }
    save({ ...value, pending: null });
    accept(reply);
    return reply;
  }
  async function continuePlay(value: Intent, reply: RoundReply<V, R>): Promise<RoundView<V, R>> {
    save({ ...value, roundId: reply.round.id });
    accept(reply, true);
    const replayed = await replayPending(load()!);
    if (replayed) reply = replayed;
    if (reply.round.status !== 'starting') {
      if (reply.round.paid) reply = await roundRequest({ type: 'resume', roundId: reply.round.id });
      accept(reply);
      watch();
      return reply.round;
    }
    value = load()!;
    // A known successful payment is never reopened while the webhook catches up.
    if (!reply.round.paid && reply.payment && value.charge !== 'confirmed') {
      if (Date.parse(reply.payment.expiresAt) <= Date.now())
        throw new EngineError('payment_expired', 'This unpaid entry has expired.');
      save({ ...value, charge: 'requested' });
      await aborted(
        Promise.resolve().then(() => {
          alive();
          return charge(reply.payment!);
        }),
        life.signal,
      );
      alive();
      save({ ...load()!, charge: 'confirmed' });
    }
    const deadline = Date.now() + confirmationMs;
    for (;;) {
      alive();
      if (reply.round.status !== 'starting') {
        accept(reply);
        watch();
        return reply.round;
      }
      if (reply.round.paid) {
        // Server resume owns the internal start identity and clock. App code does not see it.
        reply = await roundRequest({ type: 'resume', roundId: reply.round.id });
        accept(reply, true);
        if (reply.round.status !== 'starting') continue;
      }
      if (Date.now() >= deadline)
        throw new EngineError(
          'confirmation_pending',
          'Confirmation is taking longer than expected. Resume this entry to continue.',
        );
      await delay(pollMs);
      reply = await roundRequest({ type: 'get', roundId: reply.round.id });
      accept(reply, true);
    }
  }

  const client: P2PClient<V, R> = {
    play(input = {}) {
      const offerId = input.offerId ?? 'default';
      return run(`play:${offerId}`, async () => {
        publish({ ...snapshot, phase: 'starting', error: null });
        let value = load();
        if (value?.roundId) {
          const existing = await roundRequest({ type: 'get', roundId: value.roundId });
          // Finish an uncertain accepted action before considering a new paid entry.
          if (value.pending) return continuePlay(value, existing);
          if (!terminal(existing.round)) {
            if (value.offerId !== offerId)
              throw new EngineError(
                'active_entry',
                'Resume the existing entry before choosing another offer.',
              );
            return continuePlay(value, existing);
          }
          value = null;
        }
        if (value && value.offerId !== offerId) throw new EngineError('active_entry');
        if (!value)
          value = {
            version: 1,
            commandId: crypto.randomUUID(),
            offerId,
            roundId: null,
            charge: 'new',
            pending: null,
          };
        return continuePlay(value, await requestPlay(value));
      });
    },
    resume(roundId) {
      return run(`resume:${roundId ?? ''}`, async () => {
        publish({ ...snapshot, phase: 'starting', error: null });
        let value = load();
        if (roundId && value?.roundId !== roundId) {
          if (value) {
            if (!value.roundId || value.pending)
              throw new EngineError(
                'active_entry',
                'Resume the existing entry before switching rounds.',
              );
            const existing = await roundRequest({ type: 'get', roundId: value.roundId });
            if (!terminal(existing.round))
              throw new EngineError(
                'active_entry',
                'Resume the existing entry before switching rounds.',
              );
          }
          value = {
            version: 1,
            commandId: crypto.randomUUID(),
            offerId: 'default',
            roundId,
            charge: 'new',
            pending: null,
          };
        }
        if (!value) throw new EngineError('no_active_entry');
        // Validate a selected deep link before replacing the retained intent.
        const reply = value.roundId
          ? await roundRequest({ type: 'get', roundId: value.roundId })
          : await requestPlay(value);
        return continuePlay(value, reply);
      });
    },
    act(action) {
      let fingerprint: string;
      try {
        fingerprint = JSON.stringify(action);
        if (fingerprint === undefined) throw new Error();
      } catch {
        return Promise.reject(new EngineError('invalid_action'));
      }
      return run(`act:${fingerprint}`, async () => {
        const value = load();
        if (!value?.roundId || !current || current.round.id !== value.roundId)
          throw new EngineError('not_playing');
        if (value.pending && JSON.stringify(value.pending.action) !== fingerprint)
          throw new EngineError(
            'operation_pending',
            'Resume the previous action before sending another.',
          );
        if (!value.pending && !current.round.canAct) throw new EngineError('round_closed');
        const pending: Extract<EngineRequest, { type: 'act' }> = value.pending ?? {
          type: 'act',
          roundId: value.roundId,
          commandId: crypto.randomUUID(),
          sequence: current.sequence,
          action: JSON.parse(fingerprint),
        };
        save({ ...value, pending });
        let reply: RoundReply<V, R>;
        try {
          reply = await roundRequest(pending);
        } catch (error) {
          if (error instanceof TransportError && !error.retryable) {
            save({ ...load()!, pending: null });
            // A rejected action may mean another tab/deadline advanced play.
            try {
              accept(await roundRequest({ type: 'get', roundId: value.roundId }));
            } catch {
              /* Preserve the original action error. */
            }
          }
          throw error;
        }
        save({ ...load()!, pending: null });
        accept(reply);
        watch();
        return reply.round;
      });
    },
    async get(roundId) {
      return (await roundRequest({ type: 'get', roundId })).round;
    },
    async history(input = {}) {
      const reply = await request({ type: 'history', ...input });
      if (reply.kind !== 'history') throw new EngineError('invalid_response');
      return { rounds: reply.rounds, cursor: reply.cursor };
    },
    subscribe(listener) {
      alive();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    dispose() {
      stopWatch();
      life.abort();
      listeners.clear();
    },
  };
  return client;
}
