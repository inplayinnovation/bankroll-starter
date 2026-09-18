import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';

import { MatchmakingError } from '@joinbankroll/sdk/matchmaking';
import {
  claimCharge,
  HSUSD_MINT,
  settlePayout,
  type PayoutDocument,
} from '@joinbankroll/sdk/server';
import { updateJson } from '@joinbankroll/sdk/store';
import { storeDirectory } from '@joinbankroll/sdk/store/fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createP2P } from '@/lib/p2p';
import { roundPath, startEntry } from '@/lib/p2p/entries';
import { entryIndexPath } from '@/lib/p2p/entry-index';
import { matchPath } from '@/lib/p2p/settlement';
import type { GameHooks, MatchResult, PaidRound } from '@/lib/p2p/types';
import { storeBackend } from '@/lib/store';

// This game exists only here. No Word Hunt module or recipe is imported.
type CardGame = { card: number | null };
type Conditions = { seed: number };
type CardRound = PaidRound<CardGame, Conditions>;
const hooks: GameHooks<CardGame, Conditions> = {
  conditions: {
    key: 'test-high-card:1',
    validate(payload) {
      const seed = (payload as Partial<Conditions> | null)?.seed;
      if (typeof seed !== 'number' || !Number.isSafeInteger(seed))
        throw new MatchmakingError('invalid_response', 'Invalid card seed');
      return { seed };
    },
  },
  terminal: (game) => (game.card === null ? null : { game, reason: 'played' }),
  outcome(a, b) {
    if (a.reason === 'forfeited' && b.reason === 'forfeited') return { kind: 'tie', winner: null };
    if (a.reason === 'forfeited' || b.reason === 'forfeited')
      return { kind: 'forfeit', winner: a.reason === 'forfeited' ? b.id : a.id };
    return a.game!.card === b.game!.card
      ? { kind: 'tie', winner: null }
      : { kind: 'win', winner: a.game!.card! > b.game!.card! ? a.id : b.id };
  },
};

vi.mock('@joinbankroll/sdk/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@joinbankroll/sdk/server')>()),
  claimCharge: vi.fn(),
  settlePayout: vi.fn(),
}));

const store = storeBackend();
const paths = new Set<string>();
const origin = 'https://high-card.test';
let now: number;
let payee: string;
let creatorWallet: string;
let mode: ReturnType<typeof makeMode>;
function makeMode(policy = {}) {
  return createP2P({
    hooks,
    policy,
    store,
    signer: () => {
      throw new Error('The mocked SDK helper must own signing');
    },
    paymentTerms: () => ({ payee, creatorWallet, mint: HSUSD_MINT }),
  });
}

beforeAll(() => {
  expect(process.env.NODE_ENV).toBe('test');
  expect(['fs', 'blob']).toContain(process.env.STORE);
  if (process.env.STORE === 'fs') expect(storeDirectory()).toBe('bankroll/test');
  else {
    expect(process.env.DANGEROUS_BLOB_TOKEN).toBeTruthy();
    expect(process.env.BLOB_READ_WRITE_TOKEN).toBe(process.env.DANGEROUS_BLOB_TOKEN);
  }
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('BANKROLL_MOCK', '1');
  vi.stubEnv('CRON_SECRET', 'test-cron-secret');
  now = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  payee = `card-treasury-${randomUUID()}`;
  creatorWallet = `card-creator-${randomUUID()}`;
  mode = makeMode();
  vi.mocked(claimCharge).mockImplementation(async ({ signature, expected }) =>
    signature
      ? {
          created: true,
          charge: { ...expected, memo: expected.memo ?? null, signature, slot: 123 },
        }
      : null,
  );
  vi.mocked(settlePayout).mockImplementation(async (path, options) => {
    const round = await updateJson<PayoutDocument>(options.store, path, (current) => ({
      ...current,
      payout: current.payout ? { ...current.payout, status: 'paid' } : null,
    }));
    return round.payout;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  if (process.env.STORE === 'fs' && storeDirectory() === 'bankroll/test')
    await Promise.all([...paths].map((path) => rm(`${storeDirectory()}/${path}`, { force: true })));
});

async function enter(seed: number): Promise<CardRound> {
  const wallet = `card-player-${randomUUID()}`;
  const round = await mode.prepareEntry(wallet, origin, { card: null }, { seed });
  paths.add(roundPath(wallet, round.id));
  paths.add(entryIndexPath(round.id));
  await mode.confirmEntry(wallet, round.id, `charge-${round.id}`);
  return mode.syncEntry(wallet, round.id, origin);
}
const play = (round: CardRound, card: number) =>
  mode.changeEntry(round.wallet, round.id, (current) => ({
    ...current,
    entry: startEntry(current.entry, now),
    game: { card },
  }));

describe('P2P with a second game', () => {
  it.each([false, true])('enters, claims, pairs, and settles high card (tie=%s)', async (tie) => {
    const a = await enter(42);
    const b = await enter(999);
    const first = await mode.syncEntry(a.wallet, a.id, origin);
    expect(first.entry.conditions).toEqual({ seed: 42 });
    expect(b.entry.conditions).toEqual(first.entry.conditions);
    expect(b.entry.ticketInput.payload).toEqual({ seed: 999 });
    expect(claimCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: roundPath(a.wallet, a.id),
        store,
        expected: {
          payer: a.wallet,
          payee,
          mint: HSUSD_MINT,
          amountCents: 100,
          memo: `entry:${a.id}`,
        },
      }),
    );
    await play(a, 9);
    expect(await mode.resolveMatch(await mode.readEntry(a.wallet, a.id))).toBeNull();
    await play(b, tie ? 9 : 4);
    const results = await Promise.all([
      mode.resolveMatch(await mode.readEntry(a.wallet, a.id)),
      mode.resolveMatch(await mode.readEntry(b.wallet, b.id)),
    ]);
    expect(results[0]).toEqual(results[1]);
    const result = results[0]!;
    paths.add(matchPath(result.id));
    expect(result.outcome).toEqual(
      tie ? { kind: 'tie', winner: null } : { kind: 'win', winner: a.id },
    );
    expect(result.players.map((player) => player.game)).toEqual([
      { card: 9 },
      { card: tie ? 9 : 4 },
    ]);
    expect(result.payout.recipients).toEqual([
      { to: a.wallet, token: HSUSD_MINT, amountCents: tie ? 100 : 180 },
      { to: b.wallet, token: HSUSD_MINT, amountCents: tie ? 100 : 0 },
      { to: creatorWallet, token: HSUSD_MINT, amountCents: tie ? 0 : 20 },
    ]);
    expect(result.payout.memo).toBe(`duel:${result.id}`);
    expect(settlePayout).not.toHaveBeenCalled();
    await mode.reconcileEntry(a.wallet, a.id, origin);
    expect(
      (await store.readJson<MatchResult<CardGame>>(matchPath(result.id)))!.value.payout.status,
    ).toBe('paid');
    await expect(mode.cancelEntry(a.wallet, a.id, origin)).rejects.toMatchObject({
      code: 'not_refundable',
    });
  });

  it('records and settles a cancelled high-card stake on the round document', async () => {
    const round = await enter(7);
    const cancelled = await mode.cancelEntry(round.wallet, round.id, origin);
    expect(cancelled.game).toEqual({ card: null });
    expect(cancelled.entry.ticket?.state).toBe('cancelled');
    expect(cancelled.payout).toMatchObject({
      status: 'pending',
      memo: `refund:${round.id}`,
      recipients: [{ to: round.wallet, token: HSUSD_MINT, amountCents: 100 }],
    });
    await mode.reconcileEntry(round.wallet, round.id, origin);
    expect((await mode.readEntry(round.wallet, round.id)).payout?.status).toBe('paid');
  });

  it('snapshots configurable prices, fees, and no-show policy without game knowledge', async () => {
    mode = makeMode({ entryCents: 200, creatorFeeBps: 500, startWindowMs: 10_000 });
    const a = await enter(1);
    const b = await enter(2);
    await play(a, 0);
    mode = makeMode({ entryCents: 100, creatorFeeBps: 0, startWindowMs: 99_000 });
    now += 10_000;
    await mode.reconcileEntry(a.wallet, a.id, origin);
    const current = await mode.readEntry(a.wallet, a.id);
    if (current.entry.ticket?.state !== 'matched') throw new Error('Expected match');
    const path = matchPath(current.entry.ticket.match.id);
    paths.add(path);
    const result = (await store.readJson<MatchResult<CardGame>>(path))!.value;
    expect((await mode.readEntry(b.wallet, b.id)).entry.status).toBe('forfeited');
    expect(result.outcome).toEqual({ kind: 'forfeit', winner: a.id });
    expect(result.payout.recipients.map((line) => line.amountCents)).toEqual([380, 0, 20]);
  });
});
