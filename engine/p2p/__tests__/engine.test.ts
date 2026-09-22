import { describe, expect, it, vi } from 'vitest';

import {
  wordsGame,
  type WordsAction,
  type WordsChallenge,
  type WordsResult,
  type WordsState,
  type WordsView,
} from '../examples/words';
import { createLifecycle as createP2PEngine } from '../lifecycle';
import type { Actor, EngineOptions, RoundSnapshot } from '../types';
import { createHarness } from './harness';

const alice = { wallet: 'alice' };
const bob = { wallet: 'bob' };
type View = RoundSnapshot<WordsView, WordsResult>;
type Options = EngineOptions<WordsChallenge, WordsState, WordsAction, WordsResult, WordsView>;

function setup(options: Partial<Options> = {}) {
  const harness = createHarness();
  const settings = {
    game: wordsGame,
    store: harness.store,
    primitives: harness.primitives,
    treasury: harness.treasury,
    origin: harness.origin,
    now: harness.now,
    ...options,
  };
  const engine = createP2PEngine(settings);
  harness.connect(engine.webhook);
  let commands = 0;
  const commandId = () => `command-${++commands}`;

  async function enter(actor: Actor, offerId = 'default') {
    return (await engine.enter(actor, { commandId: commandId(), offerId })).round;
  }
  async function paid(actor: Actor, offerId = 'default') {
    const round = await enter(actor, offerId);
    harness.pay(round.payment, actor.wallet);
    await harness.flush();
    return engine.get(actor, round.id);
  }
  async function start(actor: Actor, round: View) {
    return (await engine.start(actor, { roundId: round.id, commandId: commandId() })).round;
  }
  async function act(actor: Actor, round: View, action: WordsAction) {
    return (
      await engine.act(actor, {
        roundId: round.id,
        commandId: commandId(),
        sequence: round.sequence,
        action,
      })
    ).round;
  }
  async function word(actor: Actor, round: View, value = 'CAT') {
    expect(round.game).not.toBeNull();
    return act(actor, round, {
      type: 'word',
      path: [...value].map((letter) => round.game!.board.indexOf(letter)),
    });
  }
  async function finish(actor: Actor, round: View) {
    return act(actor, round, { type: 'finish' });
  }
  return { harness, engine, settings, commandId, enter, paid, start, act, word, finish };
}

describe('paid asynchronous duel engine', () => {
  it('automatically admits verified payments and hides each challenge until start', async () => {
    const { harness, engine, enter } = setup();
    const entry = await enter(alice);
    expect(entry).toMatchObject({
      status: 'awaiting_payment',
      paid: false,
      game: null,
      result: null,
    });
    expect(harness.tickets.size).toBe(0);
    const event = harness.pay(entry.payment, alice.wallet);
    await harness.flush();
    const ready = await engine.get(alice, entry.id);
    expect(ready).toMatchObject({
      status: 'ready',
      paid: true,
      opponent: 'waiting',
      game: null,
      allowed: { start: true },
    });
    expect(ready.deadlines.queue).toBe(harness.now() + 24 * 60 * 60_000);
    expect(harness.tickets.get(entry.id)?.admission?.input.expiresAt).toBe(ready.deadlines.queue);
    expect([...harness.timers.values()].map((timer) => timer.meta.purpose)).toEqual(['queue']);
    const count = harness.timers.size;
    await harness.deliver(event);
    expect(harness.tickets.size).toBe(1);
    expect(harness.timers.size).toBe(count);
  });

  it('lets a player finish first, adopts that challenge for the entrant, and pays one match', async () => {
    const challenge = vi
      .fn(wordsGame.challenge)
      .mockReturnValueOnce({ board: 'CATRESDOG' })
      .mockReturnValueOnce({ board: 'DRCOEAGST' });
    const test = setup({ game: { ...wordsGame, challenge } });
    const { harness, engine } = test;
    let a = await test.start(alice, await test.paid(alice));
    a = await test.word(alice, a);
    a = await test.word(alice, a, 'DOG');
    a = await test.finish(alice, a);
    expect(a).toMatchObject({
      status: 'finished',
      opponent: 'waiting',
      result: { score: 2 },
      payout: null,
    });
    expect(harness.transfers).toHaveLength(0);

    const preparedB = await test.enter(bob);
    harness.pay(preparedB.payment, bob.wallet);
    await harness.flush();
    expect((await engine.get(alice, a.id)).opponent).toBe('matched');
    let b = await test.start(bob, await engine.get(bob, preparedB.id));
    expect(b.game!.board).toBe(a.game!.board);
    const ticket = harness.tickets.get(b.id)!;
    expect(ticket.admission!.input.payload).toEqual({ board: 'DRCOEAGST' });
    expect(ticket.admission!.payload).toEqual({ board: 'CATRESDOG' });
    b = await test.finish(bob, b);
    expect(b.outcome).toEqual({ kind: 'loss', amountCents: 0 });
    expect(b.payout?.status).toBe('sent');
    await harness.flush();
    expect((await engine.get(alice, a.id)).outcome).toEqual({ kind: 'win', amountCents: 180 });
    expect((await engine.get(bob, b.id)).payout?.status).toBe('paid');
    expect(harness.matches.size).toBe(1);
    expect(harness.transfers).toHaveLength(1);
    expect(harness.transfers[0].recipients).toEqual([
      { to: alice.wallet, amountCents: 180 },
      { to: bob.wallet, amountCents: 0 },
    ]);
  });

  it('makes commands and reference redeliveries idempotent while enforcing input fingerprints', async () => {
    const { harness, engine } = setup();
    const input = { offerId: 'default', commandId: 'entry' };
    const entered = await engine.enter(alice, input);
    const retried = await engine.enter(alice, input);
    expect(retried).toEqual(entered);
    expect(harness.references.size).toBe(1);
    const event = harness.pay(entered.round.payment, alice.wallet);
    await harness.flush();
    const start = { roundId: entered.round.id, commandId: 'start' };
    const started = await engine.start(alice, start);
    harness.advance(1_000);
    const startRetry = await engine.start(alice, start);
    expect(startRetry.command).toEqual(started.command);
    expect(startRetry.round.deadlines).toEqual(started.round.deadlines);
    const action = {
      roundId: started.round.id,
      commandId: 'word',
      sequence: started.round.sequence,
      action: {
        type: 'word',
        path: [...'CAT'].map((letter) => started.round.game!.board.indexOf(letter)),
      },
    };
    const scored = await engine.act(alice, action);
    const scoredRetry = await engine.act(alice, action);
    expect(scoredRetry.command).toEqual(scored.command);
    expect(scoredRetry.round.game?.score).toBe(1);
    await harness.deliver(event);
    expect((await engine.get(alice, entered.round.id)).sequence).toBe(scored.round.sequence);
    await expect(
      engine.act(alice, { ...action, action: { type: 'finish' } }),
    ).rejects.toMatchObject({ code: 'command_conflict' });
    await expect(engine.enter(alice, { ...input, offerId: 'changed' })).rejects.toMatchObject({
      code: 'command_conflict',
    });
  });

  it('rejects stale action sequences without losing the successful action', async () => {
    const test = setup();
    const started = await test.start(alice, await test.paid(alice));
    const scored = await test.word(alice, started);
    await expect(
      test.engine.act(alice, {
        roundId: started.id,
        commandId: 'other-tab',
        sequence: started.sequence,
        action: { type: 'finish' },
      }),
    ).rejects.toMatchObject({ code: 'stale_sequence' });
    expect((await test.engine.get(alice, started.id)).game?.score).toBe(1);
    expect(scored.sequence).toBe(started.sequence + 1);
  });

  it('keeps reads pure even after a recorded deadline passes', async () => {
    const test = setup({ game: { ...wordsGame, durationMs: 10_000 } });
    const started = await test.start(alice, await test.paid(alice));
    test.harness.advance(10_001);
    const before = { ...test.harness.stats };
    const timers = test.harness.timers.size;
    const sends = test.harness.sends.length;
    const stale = await test.engine.get(alice, started.id);
    const history = await test.engine.history(alice);
    expect(stale).toMatchObject({ status: 'playing', result: null, allowed: { act: false } });
    expect(history.rounds).toHaveLength(1);
    expect(test.harness.stats.writes).toBe(before.writes);
    expect(test.harness.stats.creates).toBe(before.creates);
    expect(test.harness.timers.size).toBe(timers);
    expect(test.harness.sends).toHaveLength(sends);
  });

  it('refunds a late payment to an automatically expired unpaid entry', async () => {
    const test = setup();
    const pending = await test.enter(alice);
    test.harness.advance(Date.parse(pending.payment!.expiresAt) - test.harness.now());
    await test.harness.flush();
    expect(await test.engine.get(alice, pending.id)).toMatchObject({
      status: 'cancelled',
      paid: false,
      game: null,
      payout: null,
    });
    const event = test.harness.pay(pending.payment, alice.wallet);
    await test.harness.deliver(event); // A delayed confirmation arrives after observation expiry.
    await test.harness.flush();
    await test.harness.deliver(event);
    expect(await test.engine.get(alice, pending.id)).toMatchObject({
      status: 'cancelled',
      paid: true,
      game: null,
      payout: { kind: 'refund', status: 'paid' },
    });
    expect(test.harness.transfers.map((transfer) => transfer.recipients)).toEqual([
      [{ to: alice.wallet, amountCents: 100 }],
    ]);
    expect(test.harness.matches.size).toBe(0);
  });

  it('refunds an unmatched completed round at the authoritative queue cutoff', async () => {
    const test = setup({ offers: { default: { queueWindowMs: 60_000 } } });
    let a = await test.start(alice, await test.paid(alice));
    a = await test.word(alice, a);
    a = await test.finish(alice, a);
    expect(a.result?.score).toBe(1);
    test.harness.advance(60_000);
    await test.harness.flush();
    const refunded = await test.engine.get(alice, a.id);
    expect(refunded).toMatchObject({
      status: 'cancelled',
      result: { score: 1 },
      payout: { kind: 'refund', status: 'paid' },
      outcome: null,
    });
    expect(test.harness.tickets.get(a.id)).toMatchObject({ state: 'cancelled', reason: 'expired' });
    expect(test.harness.transfers[0].recipients).toEqual([{ to: alice.wallet, amountCents: 100 }]);
  });

  it('lets a pre-cutoff match win over a delayed queue-expiry delivery', async () => {
    const test = setup({ offers: { default: { queueWindowMs: 60_000 } } });
    let a = await test.start(alice, await test.paid(alice));
    a = await test.word(alice, a);
    a = await test.finish(alice, a);
    test.harness.advance(59_000);
    const b = await test.paid(bob);
    test.harness.advance(2_000);
    await test.harness.flush();
    expect((await test.engine.get(alice, a.id)).payout).toBeNull();
    await test.finish(bob, await test.start(bob, b));
    await test.harness.flush();
    expect((await test.engine.get(alice, a.id)).outcome).toEqual({ kind: 'win', amountCents: 180 });
    expect(test.harness.transfers).toHaveLength(1);
  });

  it('awards a completed player against an unstarted entrant without either browser polling', async () => {
    const test = setup({ offers: { default: { startWindowMs: 60_000 } } });
    const a = await test.finish(alice, await test.start(alice, await test.paid(alice)));
    const b = await test.paid(bob);
    test.harness.advance(60_000);
    await test.harness.flush();
    expect((await test.engine.get(alice, a.id)).outcome).toEqual({ kind: 'win', amountCents: 180 });
    expect((await test.engine.get(bob, b.id)).status).toBe('forfeited');
    expect(test.harness.transfers).toHaveLength(1);
  });

  it('applies no-show policy to an offline waiter and refunds a double no-show', async () => {
    const test = setup({ offers: { default: { startWindowMs: 60_000 } } });
    const a = await test.paid(alice);
    const b = await test.paid(bob);
    test.harness.advance(60_000);
    await test.harness.flush();
    expect(await test.engine.get(alice, a.id)).toMatchObject({
      status: 'forfeited',
      outcome: { kind: 'tie', amountCents: 100 },
    });
    expect(await test.engine.get(bob, b.id)).toMatchObject({
      status: 'forfeited',
      outcome: { kind: 'tie', amountCents: 100 },
    });
    expect(test.harness.transfers[0].recipients).toEqual([
      { to: alice.wallet, amountCents: 100 },
      { to: bob.wallet, amountCents: 100 },
    ]);
  });

  it('enforces the no-show cutoff before the minute-rounded alarm arrives', async () => {
    const test = setup({ offers: { default: { startWindowMs: 30_000 } } });
    const a = await test.paid(alice);
    await test.paid(bob);
    test.harness.advance(30_001);
    expect(test.harness.events).toHaveLength(0);
    await expect(
      test.engine.start(alice, { roundId: a.id, commandId: 'too-late' }),
    ).rejects.toMatchObject({ code: 'round_closed' });
    await test.harness.flush();
    expect((await test.engine.get(alice, a.id)).status).toBe('forfeited');
  });

  it('finalizes real game deadlines using their effective time when timer delivery is late', async () => {
    const step = vi.fn(wordsGame.step);
    const test = setup({ game: { ...wordsGame, durationMs: 10_000, step } });
    const a = await test.start(alice, await test.paid(alice));
    const b = await test.start(bob, await test.paid(bob));
    const due = a.deadlines.submission!;
    test.harness.advance(90_000);
    await test.harness.flush();
    const deadlineCalls = step.mock.calls.filter((call) => call[1].type === 'deadline');
    expect(deadlineCalls).toHaveLength(2);
    expect(deadlineCalls.map((call) => call[2].now)).toEqual([due, due]);
    expect((await test.engine.get(alice, a.id)).status).toBe('finished');
    expect((await test.engine.get(bob, b.id)).status).toBe('finished');
    expect(test.harness.transfers).toHaveLength(1);
  });

  it('isolates wallet reads and paginates each wallet history in newest-first order', async () => {
    const test = setup();
    const first = await test.enter(alice);
    test.harness.advance(1);
    const second = await test.enter(alice);
    test.harness.advance(1);
    const third = await test.enter(alice);
    const other = await test.enter(bob);
    await expect(test.engine.get(bob, first.id)).rejects.toMatchObject({ code: 'not_found' });
    const page = await test.engine.history(alice, { limit: 2 });
    expect(page.rounds.map((round) => round.id)).toEqual([third.id, second.id]);
    expect(page.cursor).not.toBeNull();
    const next = await test.engine.history(alice, { limit: 2, cursor: page.cursor! });
    expect(next.rounds.map((round) => round.id)).toEqual([first.id]);
    expect(next.cursor).toBeNull();
    expect((await test.engine.history(bob)).rounds.map((round) => round.id)).toEqual([other.id]);
    await expect(test.engine.history(bob, { cursor: page.cursor! })).rejects.toMatchObject({
      code: 'invalid_cursor',
    });
    await expect(test.engine.history(alice, { limit: 0 })).rejects.toMatchObject({
      code: 'invalid_limit',
    });
  });

  it('pins old game versions and prices while new entries use newly approved offers', async () => {
    const test = setup();
    const a = await test.paid(alice);
    const pendingB = await test.enter(bob);
    const upgraded = createP2PEngine({
      ...test.settings,
      game: { ...wordsGame, version: 2, durationMs: 60_000 },
      previousVersions: [wordsGame],
      offers: { default: { entryCents: 500 } },
    });
    test.harness.connect(upgraded.webhook);
    test.harness.pay(pendingB.payment, bob.wallet);
    await test.harness.flush();
    const startedA = await upgraded.start(alice, { roundId: a.id, commandId: 'start-old-a' });
    expect(startedA.round.version).toBe(1);
    expect(startedA.round.entryCents).toBe(100);
    expect(startedA.round.deadlines.submission).toBe(test.harness.now() + 120_000);
    const startedB = await upgraded.start(bob, { roundId: pendingB.id, commandId: 'start-old-b' });
    for (const [actor, started] of [
      [alice, startedA],
      [bob, startedB],
    ] as const) {
      await upgraded.act(actor, {
        roundId: started.round.id,
        commandId: 'finish-old',
        sequence: started.round.sequence,
        action: { type: 'finish' },
      });
    }
    await test.harness.flush();
    expect((await upgraded.get(alice, a.id)).outcome).toEqual({ kind: 'tie', amountCents: 100 });
    const fresh = await upgraded.enter({ wallet: 'charlie' }, { commandId: 'new-version' });
    expect(fresh.round).toMatchObject({
      version: 2,
      entryCents: 500,
      payment: { amountCents: 500 },
    });
  });

  it('rejects unavailable versions and invalid offers before admitting new payment', async () => {
    const test = setup({ offers: { default: {}, invalid: { entryCents: 1 } } });
    await expect(
      test.engine.enter(alice, { commandId: 'unknown', offerId: 'unknown' }),
    ).rejects.toMatchObject({ code: 'unknown_offer' });
    await expect(
      test.engine.enter(alice, { commandId: 'invalid', offerId: 'invalid' }),
    ).rejects.toMatchObject({ code: 'invalid_offer' });
    expect(test.harness.references.size).toBe(0);
    const a = await test.paid(alice);
    const upgraded = createP2PEngine({ ...test.settings, game: { ...wordsGame, version: 2 } });
    await expect(
      upgraded.start(alice, { roundId: a.id, commandId: 'missing-version' }),
    ).rejects.toMatchObject({ code: 'game_version_unavailable' });
  });
});
