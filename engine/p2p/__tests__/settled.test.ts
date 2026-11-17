import type { TicketInput } from '@joinbankroll/sdk/matchmaking';
import { MOCK_OPPONENT } from '@joinbankroll/sdk/mock';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  wordsGame,
  type WordsAction,
  type WordsChallenge,
  type WordsResult,
  type WordsState,
  type WordsView,
} from '../examples/words';
import {
  createLifecycle as createP2PEngine,
  SETTLED_HOOK_LIMIT_MS,
  STAND_IN_USERNAME,
} from '../lifecycle';
import type { Actor, EngineOptions, RoundSnapshot, Settlement } from '../types';
import { createHarness } from './harness';

const alice = { wallet: 'alice', username: 'alice_h' };
const bob = { wallet: 'bob', username: 'bob_h' };
type View = RoundSnapshot<WordsView, WordsResult>;
type Options = EngineOptions<WordsChallenge, WordsState, WordsAction, WordsResult, WordsView>;

/** Both players get the same board, so a word one of them plays is a word the other could. */
const game: typeof wordsGame = { ...wordsGame, challenge: () => ({ board: 'CATRESDOG' }) };

function setup(options: Partial<Options> = {}) {
  const harness = createHarness();
  const settled: Array<Settlement<WordsResult>> = [];
  const engine = createP2PEngine({
    game,
    store: harness.store,
    primitives: harness.primitives,
    treasury: harness.treasury,
    origin: harness.origin,
    now: harness.now,
    onSettled: (settlement) => {
      settled.push(settlement);
    },
    ...options,
  });
  harness.connect(engine.webhook);
  let commands = 0;
  const commandId = () => `command-${++commands}`;

  async function paid(actor: Actor) {
    const round = (await engine.enter(actor, { commandId: commandId(), offerId: 'default' })).round;
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
    return act(actor, round, {
      type: 'word',
      path: [...value].map((letter) => round.game!.board.indexOf(letter)),
    });
  }
  const finish = (actor: Actor, round: View) => act(actor, round, { type: 'finish' });
  /** Alice scores one word and finishes; Bob is paired, started, and has yet to finish. */
  async function aliceAheadOfBob() {
    let a = await start(alice, await paid(alice));
    a = await finish(alice, await word(alice, a));
    const b = await start(bob, await paid(bob));
    return { a, b };
  }
  return { harness, engine, settled, paid, start, act, word, finish, aliceAheadOfBob };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('onSettled', () => {
  it('tells the app once, after the payout is sent, what each player sees', async () => {
    const sendsWhenTold: number[] = [];
    const seen: Array<Settlement<WordsResult>> = [];
    const test = setup({
      onSettled: (settlement) => {
        sendsWhenTold.push(test.harness.sends.length);
        seen.push(settlement);
      },
    });
    const { a, b } = await test.aliceAheadOfBob();
    expect(seen).toHaveLength(0);
    await test.finish(bob, b);
    expect(sendsWhenTold).toEqual([1]);
    expect(seen).toEqual([
      {
        matchId: [...test.harness.matches.keys()][0],
        origin: 'https://engine.example.test',
        offerId: 'default',
        entryCents: 100,
        players: [
          {
            wallet: 'alice',
            username: 'alice_h',
            roundId: a.id,
            outcome: { kind: 'win', amountCents: 180 },
            result: { score: 1, wordCount: 1 },
            opponentUsername: 'bob_h',
            opponentResult: { score: 0, wordCount: 0 },
          },
          {
            wallet: 'bob',
            username: 'bob_h',
            roundId: b.id,
            outcome: { kind: 'loss', amountCents: 0 },
            result: { score: 0, wordCount: 0 },
            opponentUsername: 'alice_h',
            opponentResult: { score: 1, wordCount: 1 },
          },
        ],
      },
    ]);
    // The app heard exactly what each player's own view shows.
    const aliceView = await test.engine.get(alice, a.id);
    expect(aliceView.outcome).toEqual(seen[0]!.players[0]!.outcome);
    expect(aliceView.opponentUsername).toBe(seen[0]!.players[0]!.opponentUsername);
    expect(aliceView.opponentResult).toEqual(seen[0]!.players[0]!.opponentResult);

    // The payout's confirmation, a second delivery of it, and both players
    // coming back are all the same settled match: the app is not told again.
    const confirmation = test.harness.events[0]!;
    await test.harness.flush();
    await test.harness.deliver(confirmation);
    await test.engine.resumeExisting(alice, a.id);
    await test.engine.resumeExisting(bob, b.id);
    expect(seen).toHaveLength(1);
    expect(test.harness.transfers).toHaveLength(1);
  });

  it('reports a tie as the entry back for both players', async () => {
    const test = setup();
    const a = await test.finish(alice, await test.start(alice, await test.paid(alice)));
    const b = await test.finish(bob, await test.start(bob, await test.paid(bob)));
    expect(test.settled).toHaveLength(1);
    expect(test.settled[0]!.players.map((player) => [player.roundId, player.outcome])).toEqual([
      [a.id, { kind: 'tie', amountCents: 100 }],
      [b.id, { kind: 'tie', amountCents: 100 }],
    ]);
  });

  it('reports a no-show as a loss with no result, told by the deadline alone', async () => {
    const test = setup({ offers: { default: { startWindowMs: 60_000 } } });
    await test.finish(alice, await test.start(alice, await test.paid(alice)));
    await test.paid(bob);
    expect(test.settled).toHaveLength(0);
    test.harness.advance(60_000);
    await test.harness.flush();
    expect(test.settled).toHaveLength(1);
    expect(test.settled[0]!.players).toMatchObject([
      { wallet: 'alice', outcome: { kind: 'win', amountCents: 180 }, opponentResult: null },
      { wallet: 'bob', outcome: { kind: 'loss', amountCents: 0 }, result: null },
    ]);
  });

  it('pays the winner when the app throws, and logs what it threw', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fault = new Error('push refused');
    const test = setup({
      onSettled: () => {
        throw fault;
      },
    });
    const { a, b } = await test.aliceAheadOfBob();
    const lost = await test.finish(bob, b);
    expect(lost).toMatchObject({
      outcome: { kind: 'loss' },
      payout: { status: 'sent' },
      issue: null,
    });
    await test.harness.flush();
    expect(await test.engine.get(alice, a.id)).toMatchObject({
      outcome: { kind: 'win', amountCents: 180 },
      payout: { status: 'paid' },
      issue: null,
    });
    expect(test.harness.transfers).toHaveLength(1);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]![1]).toBe(fault);
  });

  it('stops waiting for an app that never answers', async () => {
    vi.useFakeTimers();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const test = setup({ onSettled: () => new Promise<void>(() => {}) });
    const { b } = await test.aliceAheadOfBob();
    let answered = false;
    const finishing = test.finish(bob, b).then((round) => {
      answered = true;
      return round;
    });
    await vi.advanceTimersByTimeAsync(SETTLED_HOOK_LIMIT_MS - 1);
    expect(answered).toBe(false);
    expect(test.harness.sends).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await finishing).toMatchObject({ payout: { status: 'sent' }, issue: null });
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it('still tells the app when the payout send fails, and not again when it is sent later', async () => {
    const test = setup();
    const { a, b } = await test.aliceAheadOfBob();
    test.harness.failNext('send.before');
    await expect(test.finish(bob, b)).rejects.toThrow('Interrupted at send.before');
    expect(test.settled).toHaveLength(1);
    expect(test.harness.transfers).toHaveLength(0);
    // The claimed attempt is resolved by its watched reference, as before.
    const outcome = (await test.engine.get(alice, a.id)).outcome;
    expect(outcome).toEqual({ kind: 'win', amountCents: 180 });
    await test.engine.resumeExisting(alice, a.id);
    await test.engine.resumeExisting(bob, b.id);
    expect(test.settled).toHaveLength(1);
  });

  it('lists only the player against the stand-in opponent, and names the stand-in', async () => {
    vi.stubEnv('BANKROLL_MOCK', '1');
    const test = setup({
      game: {
        ...game,
        mockOpponent: ({ own }) => ({ score: own.score + 1, wordCount: own.wordCount }),
      },
    });
    test.harness.on('createTicket.before', async ({ input }) => {
      const proposal = input as TicketInput;
      await test.harness.primitives
        .matchmaking(test.harness.origin())
        .createTicket({ ...proposal, id: 'stand-in-ticket', player: MOCK_OPPONENT });
    });
    const a = await test.finish(alice, await test.start(alice, await test.paid(alice)));
    expect(test.settled).toHaveLength(1);
    expect(test.settled[0]!.players).toEqual([
      {
        wallet: 'alice',
        username: 'alice_h',
        roundId: a.id,
        outcome: { kind: 'loss', amountCents: 0 },
        result: { score: 0, wordCount: 0 },
        opponentUsername: STAND_IN_USERNAME,
        opponentResult: { score: 1, wordCount: 0 },
      },
    ]);
  });

  it('settles as before for an app with no hook', async () => {
    const test = setup({ onSettled: undefined });
    const { a, b } = await test.aliceAheadOfBob();
    await test.finish(bob, b);
    await test.harness.flush();
    expect((await test.engine.get(alice, a.id)).payout?.status).toBe('paid');
    expect(test.harness.transfers).toHaveLength(1);
  });
});
