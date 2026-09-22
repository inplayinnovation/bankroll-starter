import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { fsBackend, storeDirectory } from '@joinbankroll/sdk/store/fs';
import { vercelBlobBackend } from '@joinbankroll/sdk/store/vercel';

import { createLifecycle as createP2PEngine } from '../lifecycle';
import { shootingGame, simulateShot } from '../examples/shooting';
import { wordsGame } from '../examples/words';
import { createHarness } from './harness';

const alice = { wallet: 'alice' };
const bob = { wallet: 'bob' };

describe('game styles through the engine lifecycle', () => {
  it('accepts a shooting replay during submission grace and settles computed scores', async () => {
    const h = createHarness();
    const engine = createP2PEngine({ ...h, game: shootingGame });
    h.connect(engine.webhook);
    const a = await engine.enter(alice, { commandId: 'enter' });
    h.pay(a.round.payment, alice.wallet);
    await h.flush();
    const b = await engine.enter(bob, { commandId: 'enter' });
    h.pay(b.round.payment, bob.wallet);
    await h.flush();
    const startedA = await engine.start(alice, { roundId: a.round.id, commandId: 'start' });
    const startedB = await engine.start(bob, { roundId: b.round.id, commandId: 'start' });
    expect(startedA.round.game!.distanceCm).toBe(startedB.round.game!.distanceCm);
    const challenge = { distanceCm: startedA.round.game!.distanceCm };
    // Pick a legal input, not a claimed client score.
    let speedMps = 7;
    while (!simulateShot(challenge, { atMs: 0, angleDeg: 45, speedMps }).made && speedMps < 10)
      speedMps += 0.01;
    expect(speedMps).toBeLessThan(10);
    h.advance(16_000);
    await engine.act(alice, {
      roundId: a.round.id,
      commandId: 'replay',
      sequence: startedA.round.sequence,
      action: { type: 'replay', shots: [{ atMs: 0, angleDeg: 45, speedMps }], score: 9999 },
    });
    await engine.act(bob, {
      roundId: b.round.id,
      commandId: 'replay',
      sequence: startedB.round.sequence,
      action: { type: 'replay', shots: [], score: 9999 },
    });
    await h.flush();
    expect((await engine.get(alice, a.round.id)).result).toEqual({ score: 2, attempts: 1 });
    expect((await engine.get(alice, a.round.id)).outcome).toEqual({
      kind: 'win',
      amountCents: 180,
    });
    expect((await engine.get(bob, b.round.id)).outcome).toEqual({ kind: 'loss', amountCents: 0 });
    expect(h.transfers).toHaveLength(1);
  });

  it('keeps an immediate start result covered through interrupted settlement', async () => {
    const h = createHarness();
    const game = {
      ...wordsGame,
      start: () => ({
        status: 'finished' as const,
        state: { words: [], score: 0 },
        result: { score: 0, wordCount: 0 },
      }),
    };
    const engine = createP2PEngine({ ...h, game });
    h.connect(engine.webhook);
    const a = await engine.enter(alice, { commandId: 'enter' });
    h.pay(a.round.payment, alice.wallet);
    await h.flush();
    const b = await engine.enter(bob, { commandId: 'enter' });
    h.pay(b.round.payment, bob.wallet);
    await h.flush();
    await engine.start(alice, { roundId: a.round.id, commandId: 'start' });
    h.failNext('reference.after');
    await expect(engine.start(bob, { roundId: b.round.id, commandId: 'start' })).rejects.toThrow();
    expect((await engine.get(bob, b.round.id)).status).toBe('finished');
    h.advance(5 * 60_000);
    await h.flush();
    expect((await engine.get(alice, a.round.id)).payout?.status).toBe('paid');
    expect(h.transfers).toHaveLength(1);
  });

  it('advances sequence for intermediate gameplay deadlines and rejects stale actions', async () => {
    const h = createHarness();
    const engine = createP2PEngine({
      ...h,
      game: {
        ...wordsGame,
        start: (context: Parameters<typeof wordsGame.start>[0]) => ({
          ...wordsGame.start(context),
          nextDeadlineAt: context.startedAt + 60_000,
        }),
        step: (
          state: Parameters<typeof wordsGame.step>[0],
          event: Parameters<typeof wordsGame.step>[1],
          context: Parameters<typeof wordsGame.step>[2],
        ) =>
          event.type === 'deadline' && context.now < context.closesAt
            ? {
                status: 'running' as const,
                state: { ...state, score: state.score + 1 },
                nextDeadlineAt: context.closesAt,
              }
            : wordsGame.step(state, event, context),
      },
    });
    h.connect(engine.webhook);
    const a = await engine.enter(alice, { commandId: 'enter' });
    h.pay(a.round.payment, alice.wallet);
    await h.flush();
    const started = await engine.start(alice, { roundId: a.round.id, commandId: 'start' });
    h.advance(60_000);
    await h.flush();
    const current = await engine.get(alice, a.round.id);
    expect(current.sequence).toBe(started.round.sequence + 1);
    expect(current.game!.score).toBe(1);
    await expect(
      engine.act(alice, {
        roundId: a.round.id,
        commandId: 'finish',
        sequence: started.round.sequence,
        action: { type: 'finish' },
      }),
    ).rejects.toMatchObject({ code: 'stale_sequence' });
  });
});

it('persists a complete engine lifecycle using the selected real SDK store', async () => {
  // Assert isolation before constructing or touching a backend. Each run only
  // creates its unique namespace; it never deletes fixtures from another run.
  expect(process.env.NODE_ENV).toBe('test');
  if (process.env.STORE === 'blob') {
    expect(process.env.DANGEROUS_BLOB_TOKEN).toBeTruthy();
    expect(process.env.BLOB_READ_WRITE_TOKEN).toBe(process.env.DANGEROUS_BLOB_TOKEN);
  } else expect(storeDirectory()).toBe('bankroll/test');
  const store = process.env.STORE === 'blob' ? vercelBlobBackend() : fsBackend();
  const h = createHarness();
  const namespace = `engine-tests/${randomUUID()}`;
  const settings = { ...h, store, namespace, game: wordsGame, offers: { default: { queueWindowMs: 60_000 } } };
  let engine = createP2PEngine(settings);
  h.connect(engine.webhook);
  const first = await engine.enter(alice, { commandId: 'enter' });
  const second = await engine.enter(alice, { commandId: 'second' });
  h.pay(first.round.payment, alice.wallet, { signature: `charge-${randomUUID()}` });
  await h.flush();
  engine = createP2PEngine(settings); // No lifecycle state depends on this process's closure.
  h.connect(engine.webhook);
  const duplicate = await engine.enter(alice, { commandId: 'enter' });
  expect(duplicate.round.id).toBe(first.round.id);
  h.advance(60_000); // A real queue deadline owns the automatic refund after restart.
  await h.flush();
  expect((await engine.get(alice, first.round.id)).payout?.status).toBe('paid');
  const page = await engine.history(alice, { limit: 1 });
  expect(page.cursor).toBeTruthy();
  const next = await engine.history(alice, { limit: 1, cursor: page.cursor! });
  expect(new Set([...page.rounds, ...next.rounds].map((round) => round.id))).toEqual(
    new Set([first.round.id, second.round.id]),
  );
  expect(next.cursor).toBeNull();
});

it('records invalid game output as a visible fault instead of forfeiting the player', async () => {
  const h = createHarness();
  const engine = createP2PEngine({
    ...h,
    game: {
      ...wordsGame,
      start: () => ({ status: 'running', state: { words: [], score: Number.NaN } }),
    },
  });
  h.connect(engine.webhook);
  const a = await engine.enter(alice, { commandId: 'enter' });
  h.pay(a.round.payment, alice.wallet);
  await h.flush();
  const b = await engine.enter(bob, { commandId: 'enter' });
  h.pay(b.round.payment, bob.wallet);
  await h.flush();
  const failed = await engine.start(alice, { roundId: a.round.id, commandId: 'start' });
  expect(failed.round.issue).toBe('game_fault');
  expect(failed.round.status).toBe('needs_attention');
  h.advance(10 * 60_000);
  await h.flush();
  const after = await engine.get(alice, a.round.id);
  expect(after.status).toBe('needs_attention');
  expect(after.outcome).toBeNull();
  expect(after.result).toBeNull();
  expect(h.transfers).toHaveLength(0);
});

it('rejects unsupported currencies before creating a charge reference', async () => {
  const h = createHarness();
  const engine = createP2PEngine({
    ...h,
    game: wordsGame,
    treasury: {
      ...h.treasury,
      terms: () => ({ ...h.treasury.terms(), mint: 'app-token' }),
    },
  });
  await expect(engine.enter(alice, { commandId: 'enter' })).rejects.toMatchObject({
    code: 'invalid_offer',
  });
  expect(h.references.size).toBe(0);
});

it('exposes unpaid obligations to authorized operators without leaking transaction material', async () => {
  const h = createHarness({ mode: 'hosted' });
  const engine = createP2PEngine({
    ...h,
    game: wordsGame,
    authorizeOperator: (actor) => actor.wallet === 'owner',
    offers: { default: { queueWindowMs: 60_000 } },
  });
  h.connect(engine.webhook);
  const a = await engine.enter(alice, { commandId: 'enter' });
  h.pay(a.round.payment, alice.wallet);
  await h.flush();
  h.failNext('send.before');
  h.advance(60_000);
  await expect(h.flush()).rejects.toThrow();
  const attemptId = h.sends[0].id;
  h.expireAttempt(attemptId);
  await h.flush();
  const input = { wallet: alice.wallet, roundId: a.round.id };
  await expect(engine.inspect(alice, input)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(engine.reconcile(alice, input)).rejects.toMatchObject({ code: 'forbidden' });
  const before = { writes: h.stats.writes, creates: h.stats.creates, sends: h.sends.length };
  const inspected = await engine.inspect({ wallet: 'owner' }, input);
  expect(inspected.payment).toMatchObject({
    status: 'needs_attention',
    recipients: [{ to: 'alice', amountCents: 100 }],
    attempts: [{ id: attemptId, claimed: true, mode: 'hosted' }],
  });
  expect(JSON.stringify(inspected)).not.toContain('transaction');
  expect({ writes: h.stats.writes, creates: h.stats.creates, sends: h.sends.length }).toEqual(
    before,
  );
  h.setEvidence(attemptId, 'paid');
  expect((await engine.reconcile({ wallet: 'owner' }, input)).payout?.status).toBe('paid');
  expect(h.sends).toHaveLength(1);
});
