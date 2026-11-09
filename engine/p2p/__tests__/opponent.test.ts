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
import { createLifecycle as createP2PEngine, STAND_IN_USERNAME } from '../lifecycle';
import type { Actor, EngineOptions, RoundSnapshot } from '../types';
import { createHarness } from './harness';

const alice: Actor = { wallet: 'alice', username: 'alice_plays' };
const bob: Actor = { wallet: 'bob', username: 'bob_plays' };
/** A player whose session carried no handle. */
const carol: Actor = { wallet: 'carol' };
type View = RoundSnapshot<WordsView, WordsResult>;
type Options = EngineOptions<WordsChallenge, WordsState, WordsAction, WordsResult, WordsView>;

function setup(options: Partial<Options> = {}) {
  const harness = createHarness();
  const engine = createP2PEngine({
    game: wordsGame,
    store: harness.store,
    primitives: harness.primitives,
    treasury: harness.treasury,
    origin: harness.origin,
    now: harness.now,
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
  async function word(actor: Actor, round: View, value: string) {
    return act(actor, round, {
      type: 'word',
      path: [...value].map((letter) => round.game!.board.indexOf(letter)),
    });
  }
  const finish = (actor: Actor, round: View) => act(actor, round, { type: 'finish' });
  return { harness, engine, paid, start, word, finish };
}

afterEach(() => vi.unstubAllEnvs());

describe('what a round view says about the opponent', () => {
  it('names the opponent at pairing and carries their result once the match is settled', async () => {
    const test = setup({ game: { ...wordsGame, challenge: () => ({ board: 'CATRESDOG' }) } });
    let a = await test.start(alice, await test.paid(alice));
    a = await test.word(alice, a, 'CAT');
    a = await test.finish(alice, a);
    expect(a).toMatchObject({ opponent: 'waiting', opponentUsername: null, opponentResult: null });

    let b = await test.paid(bob);
    // Paired: each sees the other's handle, and nobody's result yet.
    expect(await test.engine.get(alice, a.id)).toMatchObject({
      opponent: 'matched',
      opponentUsername: 'bob_plays',
      opponentResult: null,
    });
    expect(b).toMatchObject({ opponentUsername: 'alice_plays', opponentResult: null });

    b = await test.finish(bob, await test.start(bob, b));
    await test.harness.flush();
    // Settled: each carries the other's result.
    expect(await test.engine.get(bob, b.id)).toMatchObject({
      outcome: { kind: 'loss' },
      opponentResult: a.result,
    });
    expect(await test.engine.get(alice, a.id)).toMatchObject({
      outcome: { kind: 'win' },
      opponentResult: b.result,
    });
  });

  it('shows null for an opponent whose session carried no handle', async () => {
    const test = setup();
    const a = await test.paid(alice);
    const c = await test.paid(carol);
    expect((await test.engine.get(alice, a.id)).opponentUsername).toBeNull();
    expect((await test.engine.get(carol, c.id)).opponentUsername).toBe('alice_plays');
  });

  it('leaves the result null for an opponent who never played', async () => {
    const test = setup({ offers: { default: { startWindowMs: 60_000 } } });
    const a = await test.finish(alice, await test.start(alice, await test.paid(alice)));
    await test.paid(bob);
    test.harness.advance(60_000);
    await test.harness.flush();
    expect(await test.engine.get(alice, a.id)).toMatchObject({
      outcome: { kind: 'win' },
      opponentUsername: 'bob_plays',
      opponentResult: null,
    });
  });

  it('names the stand-in and carries the result it played, under the mock', async () => {
    vi.stubEnv('BANKROLL_MOCK', '1');
    const test = setup({
      game: {
        ...wordsGame,
        challenge: () => ({ board: 'CATRESDOG' }),
        mockOpponent({ own }) {
          return { score: own.score - 1, wordCount: own.wordCount };
        },
      },
    });
    test.harness.on('createTicket.before', async ({ input }) => {
      const proposal = input as TicketInput;
      await test.harness.primitives
        .matchmaking(test.harness.origin())
        .createTicket({ ...proposal, id: 'stand-in-ticket', player: MOCK_OPPONENT });
    });
    let a = await test.start(alice, await test.paid(alice));
    a = await test.word(alice, a, 'CAT');
    a = await test.finish(alice, a);
    await test.harness.flush();
    expect(await test.engine.get(alice, a.id)).toMatchObject({
      outcome: { kind: 'win' },
      opponentUsername: STAND_IN_USERNAME,
      opponentResult: { score: a.result!.score - 1 },
    });
  });
});
