import { randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';

import bs58 from 'bs58';
import { MatchmakingError } from '@joinbankroll/sdk/matchmaking';
import { mockPayoutSigner, parseMockReference, parseMockTimer } from '@joinbankroll/sdk/mock';
import { HSUSD_MINT } from '@joinbankroll/sdk/server';
import { storeDirectory } from '@joinbankroll/sdk/store/fs';
import type { ReferenceConfirmed, ReferenceExpired } from '@joinbankroll/sdk/webhooks';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createP2P } from '@/lib/p2p';
import { roundPath, startEntry } from '@/lib/p2p/entries';
import { obligation } from '@/lib/p2p/payments';
import { DEFAULT_POLICY } from '@/lib/p2p/rules';
import { settle } from '@/lib/p2p/settle';
import { matchPath } from '@/lib/p2p/settlement';
import type { GameHooks, MatchResult, PaidRound, Payout } from '@/lib/p2p/types';
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

// Payout recipients must be real addresses, even under the mock.
const address = () => bs58.encode(randomBytes(32));

const store = storeBackend();
const paths = new Set<string>();
const origin = 'https://high-card.test';
let now: number;
let payee: string;
let creatorWallet: string;
let mode: ReturnType<typeof makeMode>;

// Bankroll, played by the test. Under the mock a payout's send posts the
// `reference.confirmed` Bankroll would deliver to the dev server; here fetch
// collects those, and `bankroll()` hands them to the webhook handlers the way
// the route would, meta filled in from the reference.
const delivered: Record<string, unknown>[] = [];
const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
  delivered.push(JSON.parse(init!.body as string));
  return Response.json({ received: true });
});
async function dispatch(event: Record<string, unknown>) {
  const meta = parseMockReference(event.reference as string)!.meta;
  if (event.type === 'reference.confirmed')
    await mode.webhook.onConfirmed({ ...event, meta } as ReferenceConfirmed);
  else await mode.webhook.onExpired({ ...event, meta } as ReferenceExpired);
}
async function bankroll() {
  for (const event of delivered.splice(0)) await dispatch(event);
}
// A charge the mock host would have settled for this entry.
const charge = (round: CardRound, over: Record<string, unknown> = {}) =>
  `mock-${Buffer.from(
    JSON.stringify({
      amountCents: round.entry.terms.entryCents,
      payer: round.wallet,
      payee,
      memo: round.entry.payment.memo,
      ...over,
    }),
  ).toString('base64url')}`;
const payoutOf = async (path: string) => (await store.readJson<{ payout: Payout }>(path))!.value.payout;

function makeMode(policy = {}) {
  return createP2P({
    hooks,
    policy,
    store,
    payoutSigner: () => mockPayoutSigner(payee),
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
  vi.stubEnv('BANKROLL_MOCK', '1');
  vi.stubGlobal('fetch', fetchMock);
  now = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  payee = address();
  creatorWallet = address();
  delivered.length = 0;
  mode = makeMode();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  if (process.env.STORE === 'fs' && storeDirectory() === 'bankroll/test')
    await Promise.all([...paths].map((path) => rm(`${storeDirectory()}/${path}`, { force: true })));
});

async function prepare(seed: number): Promise<CardRound> {
  const wallet = address();
  const round = await mode.prepareEntry(wallet, origin, { card: null }, { seed });
  paths.add(roundPath(wallet, round.id));
  return round;
}
// Bankroll saw the host's charge for the entry land.
const confirmedEntry = (round: CardRound, signature: string): ReferenceConfirmed => ({
  type: 'reference.confirmed',
  reference: round.entry.payment.reference,
  meta: { kind: 'entry', wallet: round.wallet, id: round.id },
  signature,
  slot: 1,
});
async function enter(seed: number): Promise<CardRound> {
  const round = await prepare(seed);
  await mode.webhook.onConfirmed(confirmedEntry(round, charge(round)));
  return mode.syncEntry(round.wallet, round.id, origin);
}
const play = (round: CardRound, card: number) =>
  mode.changeEntry(round.wallet, round.id, (current) => ({
    ...current,
    entry: startEntry(current.entry, now),
    game: { card },
  }));
async function matchOf(round: CardRound) {
  const current = await mode.readEntry(round.wallet, round.id);
  if (current.entry.ticket?.state !== 'matched') throw new Error('Expected match');
  const path = matchPath(current.entry.ticket.match.id);
  paths.add(path);
  return { path, result: (await store.readJson<MatchResult<CardGame>>(path))!.value };
}

describe('P2P on managed references', () => {
  it.each([false, true])('enters, pairs, and pays high card the moment the second round ends (tie=%s)', async (tie) => {
    const a = await enter(42);
    const b = await enter(999);
    const first = await mode.syncEntry(a.wallet, a.id, origin);
    expect(first.entry.conditions).toEqual({ seed: 42 });
    expect(b.entry.conditions).toEqual(first.entry.conditions);
    expect(b.entry.ticketInput.payload).toEqual({ seed: 999 });
    expect(parseMockReference(a.entry.payment.reference)?.meta).toEqual({
      kind: 'entry',
      wallet: a.wallet,
      id: a.id,
    });
    expect(a.entry.payment.signature).toBe(charge(a));

    await play(a, 9);
    expect(delivered).toHaveLength(0);
    await play(b, tie ? 9 : 4);

    // The transition that ended the second round paid the match inline.
    const { path, result } = await matchOf(a);
    expect(result.outcome).toEqual(tie ? { kind: 'tie', winner: null } : { kind: 'win', winner: a.id });
    expect(result.players.map((player) => player.game)).toEqual([{ card: 9 }, { card: tie ? 9 : 4 }]);
    expect(result.origin).toBe(origin);
    expect(result.payout.recipients).toEqual([
      { to: a.wallet, token: HSUSD_MINT, amountCents: tie ? 100 : 180 },
      { to: b.wallet, token: HSUSD_MINT, amountCents: tie ? 100 : 0 },
      { to: creatorWallet, token: HSUSD_MINT, amountCents: tie ? 0 : 20 },
    ]);
    expect(result.payout.memo).toBe(`duel:${result.id}`);
    expect(result.payout.status).toBe('sent');
    expect(result.payout.attempt?.signature).toMatch(/^mock-payout-/);
    expect(parseMockReference(result.payout.attempt!.reference)?.meta).toEqual({ kind: 'payout', path, origin });
    expect(delivered).toEqual([
      expect.objectContaining({
        type: 'reference.confirmed',
        reference: result.payout.attempt!.reference,
        signature: result.payout.attempt!.signature,
      }),
    ]);

    // Reads of a paid-for round send nothing more.
    await mode.readEntry(a.wallet, a.id);
    await mode.readEntry(b.wallet, b.id);
    expect(delivered).toHaveLength(1);

    await bankroll();
    expect(await payoutOf(path)).toMatchObject({ status: 'paid', signature: result.payout.attempt!.signature });
    await expect(mode.cancelEntry(a.wallet, a.id, origin)).rejects.toMatchObject({ code: 'not_refundable' });
  });

  it('refunds a cancelled stake from the round document', async () => {
    const round = await enter(7);
    const cancelled = await mode.cancelEntry(round.wallet, round.id, origin);
    expect(cancelled.game).toEqual({ card: null });
    expect(cancelled.entry.ticket?.state).toBe('cancelled');
    const path = roundPath(round.wallet, round.id);
    expect(await payoutOf(path)).toMatchObject({
      status: 'sent',
      memo: `refund:${round.id}`,
      recipients: [{ to: round.wallet, token: HSUSD_MINT, amountCents: 100 }],
    });
    await bankroll();
    expect(await payoutOf(path)).toMatchObject({ status: 'paid' });
  });

  it('snapshots configurable prices, fees, and no-show policy, and pays a forfeit from a read', async () => {
    mode = makeMode({ entryCents: 200, creatorFeeBps: 500, startWindowMs: 10_000 });
    const a = await enter(1);
    const b = await enter(2);
    await mode.syncEntry(a.wallet, a.id, origin);
    await play(a, 0);
    mode = makeMode({ entryCents: 100, creatorFeeBps: 0, startWindowMs: 99_000 });
    await mode.readEntry(a.wallet, a.id);
    expect(delivered).toHaveLength(0);
    now += 10_000;
    // The opponent's start window passed: this read pays the forfeit.
    await mode.readEntry(a.wallet, a.id);
    const { path, result } = await matchOf(a);
    expect((await mode.readEntry(b.wallet, b.id)).entry.status).toBe('forfeited');
    expect(result.outcome).toEqual({ kind: 'forfeit', winner: a.id });
    expect(result.payout.recipients.map((line) => line.amountCents)).toEqual([380, 0, 20]);
    await bankroll();
    expect(await payoutOf(path)).toMatchObject({ status: 'paid' });
  });

  it('ignores a reported transaction that is not the entry\'s payment, and takes the one that is', async () => {
    const round = await prepare(3);
    expect(round.entry.payment.signature).toBeNull();
    await mode.webhook.onConfirmed(confirmedEntry(round, charge(round, { amountCents: 1 })));
    expect((await mode.readEntry(round.wallet, round.id)).entry.payment.signature).toBeNull();
    await mode.webhook.onConfirmed(confirmedEntry(round, charge(round)));
    expect((await mode.readEntry(round.wallet, round.id)).entry.payment.signature).toBe(charge(round));
  });

  it('marks a payout paid only for the signature this app sent', async () => {
    const round = await enter(8);
    await mode.cancelEntry(round.wallet, round.id, origin);
    const path = roundPath(round.wallet, round.id);
    const attempt = (await payoutOf(path)).attempt!;
    await mode.webhook.onConfirmed({
      type: 'reference.confirmed',
      reference: attempt.reference,
      meta: { kind: 'payout', path, origin },
      signature: 'mock-payout-someone-else',
      slot: 1,
    });
    expect(await payoutOf(path)).toMatchObject({ status: 'sent', signature: null });
    await bankroll();
    expect(await payoutOf(path)).toMatchObject({ status: 'paid', signature: attempt.signature });
  });

  it('lets Bankroll wake it for a no-show through a timer', async () => {
    const a = await enter(42);
    await enter(999);
    const matched = await mode.syncEntry(a.wallet, a.id, origin);
    expect(matched.entry.ticket?.state).toBe('matched');
    expect(parseMockTimer(matched.entry.deadline!.id)?.meta).toEqual({ kind: 'deadline', wallet: a.wallet, id: a.id });
    expect(matched.entry.deadline!.at).toBe(new Date(now + 300_000).toISOString());
    await play(a, 9);
    expect(delivered).toHaveLength(0);

    // Nobody reads the round after the deadline; Bankroll's timer does.
    now += 300_000;
    await mode.webhook.onFired({
      type: 'timer.fired',
      id: matched.entry.deadline!.id,
      meta: { kind: 'deadline', wallet: a.wallet, id: a.id },
      at: matched.entry.deadline!.at,
    });
    const { path, result } = await matchOf(a);
    expect(result.outcome).toEqual({ kind: 'forfeit', winner: a.id });
    expect(result.payout.status).toBe('sent');
    await bankroll();
    expect(await payoutOf(path)).toMatchObject({ status: 'paid' });
  });

  it('closes an unpaid entry on cancel at once, and still refunds a charge that lands after', async () => {
    const round = await prepare(6);
    const closed = await mode.cancelEntry(round.wallet, round.id, origin);
    expect(closed.entry).toMatchObject({ status: 'cancelled', ticket: null, cancelRequested: false });
    expect(closed.payout).toBeNull();
    expect(delivered).toHaveLength(0);

    await mode.webhook.onConfirmed(confirmedEntry(round, charge(round)));
    const path = roundPath(round.wallet, round.id);
    expect(await payoutOf(path)).toMatchObject({ status: 'sent', memo: `refund:${round.id}` });
    await bankroll();
    expect(await payoutOf(path)).toMatchObject({ status: 'paid' });
  });

  it('ends an entry still unpaid when its reference expires, and leaves a paid one alone', async () => {
    const unpaid = await prepare(4);
    const paid = await enter(5);
    const expired = (round: CardRound): ReferenceExpired => ({
      type: 'reference.expired',
      reference: round.entry.payment.reference,
      meta: { kind: 'entry', wallet: round.wallet, id: round.id },
      expiredAt: round.entry.payment.expiresAt,
    });
    await mode.webhook.onExpired(expired(unpaid));
    const ended = await mode.readEntry(unpaid.wallet, unpaid.id);
    expect(ended.entry.status).toBe('cancelled');
    expect(ended.payout).toBeNull();
    await mode.webhook.onExpired(expired(paid));
    expect((await mode.readEntry(paid.wallet, paid.id)).entry.status).toBe('ready');
  });

  it('sends once when two settles race on one document', async () => {
    const path = `games/race/${randomUUID()}.json`;
    paths.add(path);
    await store.createIfAbsent(path, { payout: obligation([{ to: address(), amountCents: 100, token: HSUSD_MINT }], 'refund:race') });
    const ctx = { hooks, policy: DEFAULT_POLICY, store, payoutSigner: () => mockPayoutSigner(payee), paymentTerms: () => ({ payee, creatorWallet, mint: HSUSD_MINT }) };
    const [first, second] = await Promise.all([settle(ctx, path, origin), settle(ctx, path, origin)]);
    expect(first?.attempt?.reference).toBe(second?.attempt?.reference);
    expect(delivered).toHaveLength(1);
    const twoReads = await Promise.all([settle(ctx, path, origin), settle(ctx, path, origin)]);
    expect(twoReads.map((payout) => payout?.attempt?.reference)).toEqual([first?.attempt?.reference, first?.attempt?.reference]);
    expect(delivered).toHaveLength(1);
    await bankroll();
    expect(await payoutOf(path)).toMatchObject({ status: 'paid' });
  });

  it('builds a fresh attempt only when Bankroll reports the one in flight expired', async () => {
    const a = await enter(42);
    const b = await enter(999);
    await mode.syncEntry(a.wallet, a.id, origin);
    await play(a, 9);
    await play(b, 4);
    const { path, result } = await matchOf(a);
    const first = result.payout.attempt!;
    delivered.length = 0;

    // However old the attempt looks, only Bankroll ends it: reads resend nothing.
    now = Date.parse(first.expiresAt) + 60_000;
    await mode.readEntry(a.wallet, a.id);
    await mode.readEntry(b.wallet, b.id);
    expect((await payoutOf(path)).attempt).toEqual(first);
    expect(delivered).toHaveLength(0);

    // An expiry for some other reference changes nothing.
    const expired = (reference: string): ReferenceExpired => ({
      type: 'reference.expired',
      reference,
      meta: { kind: 'payout', path, origin },
      expiredAt: first.expiresAt,
    });
    await mode.webhook.onExpired(expired('mock-ref-someone-else'));
    expect((await payoutOf(path)).attempt).toEqual(first);
    expect(delivered).toHaveLength(0);

    // The expiry of the attempt in flight clears it and a fresh one goes out.
    await mode.webhook.onExpired(expired(first.reference));
    const second = (await payoutOf(path)).attempt!;
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(delivered).toEqual([expect.objectContaining({ type: 'reference.confirmed', reference: second.reference })]);
    await bankroll();
    expect(await payoutOf(path)).toMatchObject({ status: 'paid', signature: second.signature });
  });
});
