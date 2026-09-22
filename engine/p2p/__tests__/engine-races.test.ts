import type { TicketInput } from '@joinbankroll/sdk/matchmaking';
import { MOCK_OPPONENT } from '@joinbankroll/sdk/mock';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { wordsGame, type WordsState } from '../examples/words';
import { createLifecycle as createP2PEngine } from '../lifecycle';
import type { Round } from '../model';
import { createHarness } from './harness';

const alice = { wallet: 'alice' };
type StoredRound = Round<unknown, WordsState, unknown>;

function gate() {
  let announce = () => {};
  let release = () => {};
  const reached = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    reached,
    release,
    async pause() {
      announce();
      await resumed;
    },
  };
}

function pauseWrite(
  harness: ReturnType<typeof createHarness>,
  matches: (round: StoredRound) => boolean,
) {
  const paused = gate();
  const inspect = async ({ value }: Record<string, unknown>) => {
    const round = value as StoredRound;
    if (round.kind === 'round' && matches(round)) await paused.pause();
    else harness.on('store.write.before', inspect);
  };
  harness.on('store.write.before', inspect);
  return paused;
}

// Emulate a previously persisted cancellation while an old request resumes.
// Current app requests have no cancellation operation.
async function resumeLegacyCancellation(
  harness: ReturnType<typeof createHarness>,
  roundId: string,
) {
  const reference = [...harness.references.values()].find((reference) =>
    reference.meta.kind === 'payin' && String(reference.meta.path).endsWith(`/${roundId}.json`),
  )!;
  const path = String(reference.meta.path);
  const stored = (await harness.store.readJson<StoredRound>(path))!;
  await harness.store.writeJson(path, {
    ...stored.value,
    revision: stored.value.revision + 1,
    cancelRequested: true,
  }, stored.etag);
  const event = harness.deliveries.find((event) =>
    event.type === 'reference.confirmed' && event.reference === reference.reference,
  )!;
  await harness.deliver(event);
}

async function setup(game = wordsGame) {
  const harness = createHarness();
  const engine = createP2PEngine({
    game,
    store: harness.store,
    treasury: harness.treasury,
    primitives: harness.primitives,
    now: harness.now,
    origin: harness.origin,
    offers: { default: { startWindowMs: 60_000 } },
  });
  harness.connect(engine.webhook);
  const entered = await engine.enter(alice, { commandId: 'enter' });
  const payment = harness.pay(entered.round.payment, alice.wallet);
  await harness.flush();
  return { harness, engine, roundId: entered.round.id, payment };
}

afterEach(() => vi.unstubAllEnvs());

describe('engine concurrency', () => {
  it('accepts exactly one of two simultaneous actions based on the same sequence', async () => {
    const { harness, engine, roundId } = await setup();
    const { round } = await engine.start(alice, { roundId, commandId: 'start' });
    const paused = pauseWrite(harness, (value) => Boolean(value.play?.state.words.includes('CAT')));
    const first = engine.act(alice, {
      roundId,
      commandId: 'first-tab',
      sequence: round.sequence,
      action: { type: 'word', path: [...'CAT'].map((letter) => round.game!.board.indexOf(letter)) },
    });
    await paused.reached;
    const second = await engine.act(alice, {
      roundId,
      commandId: 'second-tab',
      sequence: round.sequence,
      action: { type: 'word', path: [...'DOG'].map((letter) => round.game!.board.indexOf(letter)) },
    });
    paused.release();
    await expect(first).rejects.toMatchObject({ code: 'stale_sequence' });
    expect(second.round.game).toMatchObject({ words: ['DOG'], score: 1 });
    expect((await engine.get(alice, roundId)).sequence).toBe(round.sequence + 1);
    expect(harness.stats.casFailures).toBeGreaterThan(0);
  });

  it('cannot reveal a started game after a legacy cancellation wins their shared conditional write', async () => {
    const { harness, engine, roundId } = await setup();
    const paused = pauseWrite(harness, (value) => value.play !== null);
    const starting = engine.start(alice, { roundId, commandId: 'start' });
    await paused.reached;
    await resumeLegacyCancellation(harness, roundId);
    paused.release();
    await expect(starting).rejects.toMatchObject({ code: 'round_closed' });
    await harness.flush();
    expect(await engine.get(alice, roundId)).toMatchObject({
      status: 'cancelled',
      game: null,
      payout: { kind: 'refund', status: 'paid' },
    });
    expect(harness.transfers).toHaveLength(1);
    expect(harness.stats.casFailures).toBeGreaterThan(0);
  });

  it('concurrent automatic starts commit one clock without resetting the winning start', async () => {
    const { harness, engine, roundId } = await setup();
    const paused = pauseWrite(harness, (value) => value.play !== null);
    const first = engine.start(alice, { roundId, commandId: 'first-start' });
    await paused.reached;
    harness.advance(1_000);
    const second = await engine.start(alice, { roundId, commandId: 'second-start' });
    paused.release();
    const resumed = await first;
    expect(resumed.round.status).toBe('playing');
    expect(resumed.round.deadlines).toEqual(second.round.deadlines);
    expect((await engine.get(alice, roundId)).deadlines).toEqual(second.round.deadlines);
    expect(harness.transfers).toHaveLength(0);
    expect(harness.stats.casFailures).toBeGreaterThan(0);
  });

  const intermediateGame: typeof wordsGame = {
    ...wordsGame,
    start(context) {
      return {
        status: 'running',
        state: { words: [], score: 0 },
        nextDeadlineAt: context.startedAt + 60_000,
      };
    },
    step(state, event, context) {
      const intermediate = context.startedAt + 60_000;
      if (event.type === 'deadline' && context.now === intermediate)
        return {
          status: 'running',
          state: { ...state, score: state.score + 10 },
          nextDeadlineAt: context.closesAt,
        };
      const progress = wordsGame.step(state, event, context);
      return progress.status === 'running' && context.now < intermediate
        ? { ...progress, nextDeadlineAt: intermediate }
        : progress;
    },
  };

  it('invalidates a paused pre-deadline action when the intermediate deadline wins the CAS', async () => {
    const { harness, engine, roundId } = await setup(intermediateGame);
    const { round } = await engine.start(alice, { roundId, commandId: 'start' });
    harness.advance(59_999);
    const paused = pauseWrite(harness, (value) => Boolean(value.play?.state.words.includes('CAT')));
    const action = engine.act(alice, {
      roundId,
      commandId: 'before-deadline',
      sequence: round.sequence,
      action: { type: 'word', path: [...'CAT'].map((letter) => round.game!.board.indexOf(letter)) },
    });
    await paused.reached;
    harness.advance(1);
    await harness.flush();
    paused.release();
    await expect(action).rejects.toMatchObject({ code: 'stale_sequence' });
    expect(await engine.get(alice, roundId)).toMatchObject({
      sequence: round.sequence + 1,
      game: { score: 10, words: [] },
    });
  });

  it('keeps a winning pre-deadline action when the intermediate deadline retries its lost CAS', async () => {
    const { harness, engine, roundId } = await setup(intermediateGame);
    const { round } = await engine.start(alice, { roundId, commandId: 'start' });
    harness.advance(59_999);
    const actionPaused = pauseWrite(harness, (value) =>
      Boolean(value.play?.state.words.includes('CAT')),
    );
    const action = engine.act(alice, {
      roundId,
      commandId: 'before-deadline',
      sequence: round.sequence,
      action: { type: 'word', path: [...'CAT'].map((letter) => round.game!.board.indexOf(letter)) },
    });
    await actionPaused.reached;
    const deadlinePaused = pauseWrite(harness, (value) => value.play?.state.score === 10);
    harness.advance(1);
    const delivery = harness.flush();
    await deadlinePaused.reached;
    actionPaused.release();
    await action;
    deadlinePaused.release();
    await delivery;
    expect(await engine.get(alice, roundId)).toMatchObject({
      sequence: round.sequence + 2,
      game: { score: 11, words: ['CAT'] },
    });
    expect(harness.stats.casFailures).toBeGreaterThan(0);
  });

  it('does not reopen a refunded entry when an old waiting response finally arrives', async () => {
    const { harness, engine, roundId } = await setup();
    const paused = gate();
    harness.on('createTicket.after', async ({ ticket }) => {
      expect(ticket).toMatchObject({ state: 'waiting' });
      await paused.pause();
    });
    const starting = engine.start(alice, { roundId, commandId: 'start' });
    await paused.reached;
    await resumeLegacyCancellation(harness, roundId);
    paused.release();
    await expect(starting).rejects.toMatchObject({ code: 'round_closed' });
    await harness.flush();
    expect(await engine.get(alice, roundId)).toMatchObject({
      status: 'cancelled',
      opponent: 'cancelled',
      game: null,
      payout: { kind: 'refund', status: 'paid' },
    });
    expect(harness.tickets.get(roundId)?.state).toBe('cancelled');
    expect(harness.transfers).toHaveLength(1);
  });

  it('handles the SDK development opponent internally without requiring a synthetic paid round', async () => {
    vi.stubEnv('BANKROLL_MOCK', '1');
    const harness = createHarness();
    const engine = createP2PEngine({
      game: wordsGame,
      store: harness.store,
      treasury: harness.treasury,
      primitives: harness.primitives,
      now: harness.now,
      origin: harness.origin,
      offers: { default: { startWindowMs: 60_000 } },
    });
    harness.connect(engine.webhook);
    harness.on('createTicket.before', async ({ input }) => {
      const proposal = input as TicketInput;
      await harness.primitives.matchmaking(harness.origin()).createTicket({
        ...proposal,
        id: 'synthetic-opponent-ticket',
        player: MOCK_OPPONENT,
      });
    });
    const entered = await engine.enter(alice, { commandId: 'enter' });
    harness.pay(entered.round.payment, alice.wallet);
    await harness.flush();
    const started = await engine.start(alice, { roundId: entered.round.id, commandId: 'start' });
    await engine.act(alice, {
      roundId: entered.round.id,
      commandId: 'finish',
      sequence: started.round.sequence,
      action: { type: 'finish' },
    });
    harness.advance(60_000);
    await harness.flush();
    expect(await engine.get(alice, entered.round.id)).toMatchObject({
      outcome: { kind: 'win', amountCents: 180 },
      payout: { status: 'paid' },
    });
    expect(harness.charges.size).toBe(1);
    expect(harness.transfers).toHaveLength(1);
    expect(harness.transfers[0].recipients).toEqual([{ to: alice.wallet, amountCents: 180 }]);
  });
});
