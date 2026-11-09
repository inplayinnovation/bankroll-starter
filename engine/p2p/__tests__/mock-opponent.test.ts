import type { TicketInput } from '@joinbankroll/sdk/matchmaking';
import { MOCK_OPPONENT } from '@joinbankroll/sdk/mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { wordsGame } from '../examples/words';
import {
  createLifecycle as createP2PEngine,
  MOCK_START_WINDOW_MS,
  mockOutcome,
} from '../lifecycle';
import { createHarness } from './harness';

const alice = { wallet: 'alice' };

/** The word game with a stand-in that plays to the outcome the developer asked for. */
const playingGame: typeof wordsGame = {
  ...wordsGame,
  mockOpponent({ own, wanted }) {
    const score = wanted === 'win' ? own.score - 1 : wanted === 'loss' ? own.score + 1 : own.score;
    return { score, wordCount: own.wordCount };
  },
};

/** One paid player, paired with the SDK's stand-in, whose own round is finished. */
async function finishedAgainstStandIn(game: typeof wordsGame) {
  const harness = createHarness();
  const engine = createP2PEngine({
    game,
    store: harness.store,
    treasury: harness.treasury,
    primitives: harness.primitives,
    now: harness.now,
    origin: harness.origin,
  });
  harness.connect(engine.webhook);
  harness.on('createTicket.before', async ({ input }) => {
    const proposal = input as TicketInput;
    await harness.primitives
      .matchmaking(harness.origin())
      .createTicket({ ...proposal, id: 'stand-in-ticket', player: MOCK_OPPONENT });
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
  // The mock payout's confirmation arrives as a webhook, like every payout's.
  await harness.flush();
  return { harness, engine, roundId: entered.round.id };
}

beforeEach(() => vi.stubEnv('BANKROLL_MOCK', '1'));
afterEach(() => vi.unstubAllEnvs());

describe('the stand-in opponent under the mock', () => {
  it.each([
    ['win', 180],
    ['loss', 0],
    ['tie', 100],
  ] as const)(
    "plays the game's answer at once: a %s for the player, paid without a wait",
    async (wanted, amountCents) => {
      vi.stubEnv('BANKROLL_MOCK_OUTCOME', wanted);
      const { harness, engine, roundId } = await finishedAgainstStandIn(playingGame);
      expect(await engine.get(alice, roundId)).toMatchObject({
        status: 'finished',
        opponent: 'matched',
        outcome: { kind: wanted, amountCents },
        payout: { kind: 'prize', status: 'paid' },
      });
      // The stand-in is never a recipient; the player's line is the whole payout.
      expect(harness.transfers).toHaveLength(1);
      expect(harness.transfers[0]!.recipients).toEqual([{ to: alice.wallet, amountCents }]);
    },
  );

  it('forfeits one minute after pairing when the game has no hook, instead of five', async () => {
    const { harness, engine, roundId } = await finishedAgainstStandIn(wordsGame);
    expect((await engine.get(alice, roundId)).outcome).toBeNull();
    const matchedAt = [...harness.matches.values()][0]!.matchedAt;
    // The player's own no-show window stays the offer's; the stand-in's is the mock's minute.
    const noShows = [...harness.timers.values()]
      .filter((timer) => timer.meta.purpose === 'no-show')
      .map((timer) => timer.dueAt);
    expect(noShows).toContain(matchedAt + MOCK_START_WINDOW_MS);
    harness.advance(MOCK_START_WINDOW_MS);
    await harness.flush();
    expect(await engine.get(alice, roundId)).toMatchObject({
      outcome: { kind: 'win', amountCents: 180 },
      payout: { status: 'paid' },
    });
    expect(harness.transfers[0]!.recipients).toEqual([{ to: alice.wallet, amountCents: 180 }]);
  });

  it('records a hook that fails as a game fault on the match, never a made-up result', async () => {
    const broken: typeof wordsGame = {
      ...wordsGame,
      mockOpponent() {
        throw new Error('no idea');
      },
    };
    const { harness, engine, roundId } = await finishedAgainstStandIn(broken);
    const round = await engine.get(alice, roundId);
    expect(round.status).toBe('needs_attention');
    expect(round.issue).toBe('game_fault');
    expect(round.outcome).toBeNull();
    harness.advance(MOCK_START_WINDOW_MS);
    await harness.flush();
    expect(harness.transfers).toHaveLength(0);
  });

  it('is never consulted outside the mock', async () => {
    vi.stubEnv('BANKROLL_MOCK', '0');
    const hook = vi.fn(() => ({ score: 99, wordCount: 1 }));
    const harness = createHarness();
    const engine = createP2PEngine({
      game: { ...wordsGame, mockOpponent: hook },
      store: harness.store,
      treasury: harness.treasury,
      primitives: harness.primitives,
      now: harness.now,
      origin: harness.origin,
    });
    harness.connect(engine.webhook);
    const a = await engine.enter(alice, { commandId: 'enter' });
    harness.pay(a.round.payment, alice.wallet);
    await harness.flush();
    const b = await engine.enter({ wallet: 'bob' }, { commandId: 'enter' });
    harness.pay(b.round.payment, 'bob');
    await harness.flush();
    await engine.start(alice, { roundId: a.round.id, commandId: 'start' });
    await engine.start({ wallet: 'bob' }, { roundId: b.round.id, commandId: 'start' });
    harness.advance(wordsGame.durationMs);
    await harness.flush();
    expect((await engine.get(alice, a.round.id)).outcome).toEqual({
      kind: 'tie',
      amountCents: 100,
    });
    expect(hook).not.toHaveBeenCalled();
  });
});

describe('mockOutcome', () => {
  it('is what the developer asked for, else one of the three by the match', () => {
    vi.stubEnv('BANKROLL_MOCK_OUTCOME', 'tie');
    expect(mockOutcome('match-1')).toBe('tie');
    vi.stubEnv('BANKROLL_MOCK_OUTCOME', 'sideways');
    const seen = new Set(Array.from({ length: 60 }, (_, i) => mockOutcome(`match-${i}`)));
    expect(seen).toEqual(new Set(['win', 'loss', 'tie']));
    expect(mockOutcome('match-7')).toBe(mockOutcome('match-7'));
  });
});
