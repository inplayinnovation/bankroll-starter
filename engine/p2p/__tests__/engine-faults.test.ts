import { describe, expect, it } from 'vitest';
import type { ConfirmedCharge } from '@joinbankroll/sdk/server';

import { createLifecycle as createP2PEngine } from '../lifecycle';
import {
  wordsGame,
  type WordsChallenge,
  type WordsResult,
  type WordsState,
} from '../examples/words';
import type { MatchDocument, Round } from '../model';
import { createHarness, type HarnessReference, type HarnessTimer } from './harness';

const alice = { wallet: 'alice' };
const bob = { wallet: 'bob' };
type Entry = Round<WordsChallenge, WordsState, WordsResult>;

function fixture(mode: 'signed' | 'hosted' = 'signed') {
  const h = createHarness({ mode });
  const engine = createP2PEngine({ game: wordsGame, ...h });
  h.connect(engine.webhook);
  return { h, engine };
}
type Fixture = ReturnType<typeof fixture>;

async function paidEntry({ h, engine }: Fixture, player = alice) {
  const { round } = await engine.enter(player, { commandId: `enter-${player.wallet}` });
  h.pay(round.payment, player.wallet);
  await h.flush();
  return round.id;
}

async function playingPair(f: Fixture) {
  const a = await paidEntry(f);
  const b = await paidEntry(f, bob);
  await f.engine.start(alice, { roundId: a, commandId: 'start-a' });
  await f.engine.start(bob, { roundId: b, commandId: 'start-b' });
  return { a, b };
}

async function finish(
  { engine }: Fixture,
  player: typeof alice,
  roundId: string,
  originalSequence?: number,
) {
  const round = await engine.get(player, roundId);
  return engine.act(player, {
    roundId,
    commandId: `finish-${player.wallet}`,
    sequence: originalSequence ?? round.sequence,
    action: { type: 'finish' },
  });
}

function pathFor(h: Fixture['h'], roundId: string) {
  const reference = [...h.references.values()].find(
    (item) => item.meta.kind === 'payin' && String(item.meta.path).endsWith(`/${roundId}.json`),
  );
  if (!reference) throw new Error('Missing entry reference');
  return String(reference.meta.path);
}

async function entry(h: Fixture['h'], roundId: string) {
  return (await h.store.readJson<Entry>(pathFor(h, roundId)))!.value;
}

// Persisted cancellations from the prior API remain obligations. The new
// dispatcher cannot create this marker; only this compatibility fixture does.
async function restoreLegacyCancellation(h: Fixture['h'], roundId: string) {
  const path = pathFor(h, roundId);
  const stored = (await h.store.readJson<Entry>(path))!;
  await h.store.writeJson(path, {
    ...stored.value,
    revision: stored.value.revision + 1,
    cancelRequested: true,
  }, stored.etag);
  const event = h.deliveries.find((event) =>
    event.type === 'reference.confirmed' && event.reference === stored.value.payment!.reference,
  );
  if (!event) throw new Error('Missing original payment event');
  await h.deliver(event);
}

function interruptMatchingWrite(h: Fixture['h'], matches: (path: string, value: Entry) => boolean) {
  const hook = ({ path, value }: Record<string, unknown>) => {
    if (matches(String(path), value as Entry)) throw new Error('Interrupted match adoption');
    h.on('store.write.before', hook);
  };
  h.on('store.write.before', hook);
}

describe('engine webhook interruption and ownership', () => {
  it('redelivers the second pay-in after matchmaking committed but lost its response', async () => {
    const f = fixture();
    const a = await paidEntry(f);
    const { round: b } = await f.engine.enter(bob, { commandId: 'enter-bob' });
    const event = f.h.pay(b.payment, bob.wallet);
    f.h.failNext('createTicket.after');
    await expect(f.h.flush()).rejects.toThrow('Interrupted');
    expect(f.h.matches.size).toBe(1);
    expect([...f.h.tickets.values()].map((ticket) => ticket.state)).toEqual(['matched', 'matched']);
    expect(f.h.events[0]).toEqual(event);
    await f.h.flush();
    expect(await f.engine.get(alice, a)).toMatchObject({
      paid: true,
      opponent: 'matched',
      allowed: { start: true },
    });
    expect(await f.engine.get(bob, b.id)).toMatchObject({
      paid: true,
      opponent: 'matched',
      allowed: { start: true },
    });
    expect(f.h.matches.size).toBe(1);
    expect(f.h.transfers).toHaveLength(0);
    expect((await entry(f.h, a)).timers['no-show']).toBeDefined();
    expect((await entry(f.h, b.id)).timers['no-show']).toBeDefined();
  });

  it('finishes adopting both players when a matched pay-in webhook resumes halfway through', async () => {
    const f = fixture();
    const a = await paidEntry(f);
    const { round: b } = await f.engine.enter(bob, { commandId: 'enter-bob' });
    interruptMatchingWrite(
      f.h,
      (path, value) => path === pathFor(f.h, a) && value.ticket?.state === 'matched',
    );
    f.h.pay(b.payment, bob.wallet);
    await expect(f.h.flush()).rejects.toThrow('Interrupted match adoption');
    expect((await entry(f.h, a)).ticket?.state).toBe('waiting');
    expect((await entry(f.h, b.id)).ticket?.state).toBe('matched');
    await f.h.flush();
    for (const id of [a, b.id]) {
      expect((await entry(f.h, id)).ticket?.state).toBe('matched');
      expect((await entry(f.h, id)).timers['no-show']).toBeDefined();
    }
    expect(f.h.matches.size).toBe(1);
    expect(f.h.events).toHaveLength(0);
  });

  it('keeps the real game deadline responsible when early settlement registration fails', async () => {
    const f = fixture();
    const { a, b } = await playingPair(f);
    await finish(f, alice, a);
    const before = (await entry(f.h, b)).timers.game!;
    const timerCount = f.h.timers.size;
    f.h.failNext('reference.after');
    await expect(finish(f, bob, b)).rejects.toThrow('Interrupted');
    expect((await entry(f.h, b)).finish?.reason).toBe('played');
    expect((await entry(f.h, b)).timers.game).toEqual(before);
    expect(f.h.transfers).toHaveLength(0);
    f.h.advance(Date.parse(before.at) - f.h.now());
    await f.h.flush();
    expect(f.h.transfers).toHaveLength(1);
    expect(await f.engine.get(alice, a)).toMatchObject({
      payout: { status: 'paid' },
      outcome: { kind: 'tie', amountCents: 100 },
    });
    expect(await f.engine.get(bob, b)).toMatchObject({ payout: { status: 'paid' } });
    expect(f.h.timers.size).toBe(timerCount);
  });

  it('fences an expired pay-in registration before its delayed writer can install it', async () => {
    const f = fixture();
    let abandoned: HarnessReference | undefined;
    f.h.on('reference.after', async (context) => {
      abandoned = context as unknown as HarnessReference;
      f.h.advance(Date.parse(abandoned.expiresAt) - f.h.now());
      await f.h.flush();
    });
    await expect(f.engine.enter(alice, { commandId: 'enter-alice' })).rejects.toThrow(
      'expired during preparation',
    );
    const shell = (await f.h.store.readJson<Entry>(String(abandoned!.meta.path)))!.value;
    expect(shell.payment).toBeNull();
    expect(shell.revision).toBeGreaterThan(Number(abandoned!.meta.baseRevision));
    const { round } = await f.engine.enter(alice, { commandId: 'enter-alice' });
    expect(round.id).toBe(shell.id);
    expect(round.payment!.reference).not.toBe(abandoned!.reference);
    expect(Date.parse(round.payment!.expiresAt)).toBeGreaterThan(f.h.now());
  });

  it('fences a timer delivered before its start transition commits and installs a fresh generation', async () => {
    const f = fixture();
    const a = await paidEntry(f);
    let abandoned: HarnessTimer | undefined;
    f.h.on('timer.after', async (context) => {
      abandoned = context as unknown as HarnessTimer;
      f.h.advance(Date.parse(abandoned.at) - f.h.now());
      await f.h.flush();
    });
    await f.engine.start(alice, { roundId: a, commandId: 'start-a' });
    const document = await entry(f.h, a);
    expect(document.timers.game!.id).not.toBe(abandoned!.id);
    expect(document.timers.game!.token).not.toBe(abandoned!.meta.token);
    expect(document.sequence).toBe(1);
    f.h.advance(Date.parse(document.timers.game!.at) - f.h.now());
    await f.h.flush();
    expect(await f.engine.get(alice, a)).toMatchObject({
      status: 'finished',
      result: { score: 0 },
      opponent: 'waiting',
    });
  });

  it('lets pairing win a legacy cancellation resumption without refunding the matched ticket', async () => {
    const f = fixture();
    const a = await paidEntry(f);
    const { round: b } = await f.engine.enter(bob, { commandId: 'enter-bob' });
    f.h.on('cancelTicket.before', async () => {
      const event = f.h.pay(b.payment, bob.wallet);
      await f.h.deliver(event);
    });
    await restoreLegacyCancellation(f.h, a);
    expect(await f.engine.get(alice, a)).toMatchObject({
      opponent: 'matched',
      allowed: { start: true },
      payout: null,
    });
    await f.h.flush();
    expect([...f.h.tickets.values()].map((ticket) => ticket.state)).toEqual(['matched', 'matched']);
    expect(f.h.transfers).toHaveLength(0);
    expect((await entry(f.h, a)).cancelRequested).toBe(false);
  });

  it('honors a legacy cancellation tombstone against delayed pairing and refunds only that entry', async () => {
    const f = fixture();
    const a = await paidEntry(f);
    const { round: b } = await f.engine.enter(bob, { commandId: 'enter-bob' });
    f.h.on('cancelTicket.after', async () => {
      await f.h.deliver(f.h.pay(b.payment, bob.wallet));
    });
    await restoreLegacyCancellation(f.h, a);
    await f.h.flush();
    expect(await f.engine.get(alice, a)).toMatchObject({
      status: 'cancelled',
      payout: { kind: 'refund', status: 'paid' },
    });
    expect(await f.engine.get(bob, b.id)).toMatchObject({ opponent: 'waiting', payout: null });
    expect(f.h.matches.size).toBe(0);
    expect(f.h.transfers.map((transfer) => transfer.recipients)).toEqual([
      [{ to: alice.wallet, amountCents: 100 }],
    ]);
  });
});

describe('engine payment evidence', () => {
  it.each(['signed', 'hosted'] as const)(
    'recovers a %s send committed before its response was lost without another payment',
    async (mode) => {
      const f = fixture(mode);
      const { a, b } = await playingPair(f);
      await finish(f, alice, a);
      f.h.failNext('send.after');
      await expect(finish(f, bob, b)).rejects.toThrow('Interrupted');
      expect(f.h.transfers).toHaveLength(1);
      await finish(f, bob, b, 1);
      expect(f.h.sends).toHaveLength(1);
      await f.h.flush();
      expect(await f.engine.get(bob, b)).toMatchObject({ payout: { status: 'paid' } });
      expect(f.h.transfers).toHaveLength(1);
    },
  );

  it('replaces an uncertain signed attempt only after expiry evidence and preserves webhook retry on RPC failure', async () => {
    const f = fixture();
    const { a, b } = await playingPair(f);
    await finish(f, alice, a);
    f.h.failNext('send.before');
    await expect(finish(f, bob, b)).rejects.toThrow('Interrupted');
    const old = [...f.h.attempts.values()][0];
    f.h.expireAttempt(old.id);
    f.h.failNext('reconcile.before', new Error('RPC unavailable'));
    await expect(f.h.flush()).rejects.toThrow('RPC unavailable');
    expect(f.h.attempts.size).toBe(1);
    expect(f.h.events[0]).toMatchObject({ type: 'reference.expired', reference: old.reference });
    f.h.setEvidence(old.id, 'retryable');
    await f.h.flush();
    expect(f.h.attempts.size).toBe(2);
    expect(f.h.transfers).toHaveLength(1);
    const ref = [...f.h.references.values()].find(
      (item) => item.meta.kind === 'payout' && item.reference !== old.reference,
    )!;
    const document = (await f.h.store.readJson<MatchDocument>(String(ref.meta.path)))!.value;
    expect(document.payout).toMatchObject({ status: 'paid', retired: [{ id: old.id }] });
    expect(await f.engine.get(alice, a)).toMatchObject({ payout: { status: 'paid' } });
  });

  it('hands off an unknown hosted send durably without a replacement or a retry timer', async () => {
    const f = fixture('hosted');
    const { a, b } = await playingPair(f);
    await finish(f, alice, a);
    const timerCount = f.h.timers.size;
    f.h.failNext('send.before');
    await expect(finish(f, bob, b)).rejects.toThrow('Interrupted');
    const attempt = [...f.h.attempts.values()][0];
    f.h.expireAttempt(attempt.id);
    await f.h.flush();
    expect(await f.engine.get(bob, b)).toMatchObject({
      status: 'needs_attention',
      payout: { status: 'needs_attention' },
    });
    await finish(f, bob, b, 1);
    expect(f.h.sends).toHaveLength(1);
    expect(f.h.attempts.size).toBe(1);
    expect(f.h.timers.size).toBe(timerCount);
    expect(f.h.events).toHaveLength(0);
  });

  it('refunds a mismatched receipt to its actual payer and for its actual whole-cent amount', async () => {
    const f = fixture();
    const { round } = await f.engine.enter(alice, { commandId: 'enter-alice' });
    f.h.pay(round.payment, 'actual-payer', { amountCents: 137 });
    await f.h.flush();
    expect(f.h.matches.size).toBe(0);
    expect(f.h.transfers.map((transfer) => transfer.recipients)).toEqual([
      [{ to: 'actual-payer', amountCents: 137 }],
    ]);
    expect(await f.engine.get(alice, round.id)).toMatchObject({
      allowed: { start: false },
      payout: { kind: 'refund', status: 'paid' },
    });
    expect((await entry(f.h, round.id)).ticket?.state).toBe('cancelled');
  });

  it.each([
    { payee: 'another-treasury' },
    { mint: 'another-mint' },
    { amountCents: 100.5 },
    { amountCents: 0 },
  ] satisfies Partial<ConfirmedCharge>[])(
    'does not refund unsafe mismatched receipt %j',
    async (overrides) => {
      const f = fixture();
      const { round } = await f.engine.enter(alice, { commandId: 'enter-alice' });
      f.h.pay(round.payment, 'actual-payer', overrides);
      await f.h.flush();
      expect(f.h.transfers).toHaveLength(0);
      expect(f.h.attempts.size).toBe(0);
      expect(await f.engine.get(alice, round.id)).toMatchObject({
        status: 'needs_attention',
        issue: 'payment_cannot_refund',
        allowed: { start: false },
      });
    },
  );
});
