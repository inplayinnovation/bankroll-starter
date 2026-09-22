import { describe, expect, it, vi } from 'vitest';

import { createP2PEngine } from '../engine';
import { wordsGame } from '../examples/words';
import { createP2PHandler } from '../http';
import type { Round } from '../model';
import type { Actor } from '../types';
import { createHarness } from './harness';

const alice = { wallet: 'alice' };
const bob = { wallet: 'bob' };

function setup() {
  const h = createHarness();
  const start = vi.fn(wordsGame.start);
  const engine = createP2PEngine({ ...h, game: { ...wordsGame, start } });
  h.connect(engine.webhook);
  return { h, engine, start };
}
type Fixture = ReturnType<typeof setup>;

async function round(engine: Fixture['engine'], actor: Actor, request: unknown) {
  const reply = await engine.handle(actor, request);
  if (reply.kind !== 'round') throw new Error('Expected a round reply');
  return reply;
}

function post(body: unknown) {
  return new Request('https://game.example/api/game', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('engine-owned player workflow', () => {
  it('exposes one dispatcher rather than app-controlled entry, start and cancellation steps', () => {
    const { engine } = setup();
    expect(Object.keys(engine).sort()).toEqual(['handle', 'inspect', 'reconcile', 'webhook']);
    expect(engine).not.toHaveProperty('enter');
    expect(engine).not.toHaveProperty('start');
    expect(engine).not.toHaveProperty('cancel');
  });

  it('keeps payment and readiness out of the player projection, then starts automatically on resume', async () => {
    const { h, engine, start } = setup();
    const request = { type: 'play', commandId: 'play-once' };
    const initial = await round(engine, alice, request);
    expect(initial.round).toMatchObject({ status: 'starting', paid: false, game: null, canAct: false });
    expect(initial.payment).toMatchObject({ amountCents: 100 });
    for (const field of ['payment', 'allowed', 'sequence', 'challenge', 'treasury'])
      expect(initial.round).not.toHaveProperty(field);

    const confirmation = h.pay(initial.payment, alice.wallet);
    const pending = await round(engine, alice, { type: 'resume', roundId: initial.round.id });
    expect(pending.round).toMatchObject({ status: 'starting', paid: false, game: null });
    expect(start).not.toHaveBeenCalled();
    await h.flush();

    const confirmed = await round(engine, alice, { type: 'get', roundId: initial.round.id });
    expect(confirmed.round).toMatchObject({ status: 'starting', paid: true, game: null });
    expect(confirmed.payment).toBeNull();
    expect(start).not.toHaveBeenCalled(); // A read does not start an absent player's clock.

    const playing = await round(engine, alice, { type: 'resume', roundId: initial.round.id });
    expect(playing.round).toMatchObject({ status: 'playing', paid: true, canAct: true });
    expect(playing.round.game?.board).toHaveLength(9);
    expect(playing.payment).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    h.advance(1_000);
    await h.deliver(confirmation);
    const duplicate = await round(engine, alice, request);
    const resumed = await round(engine, alice, { type: 'resume', roundId: initial.round.id });
    expect(duplicate.round.deadlines).toEqual(playing.round.deadlines);
    expect(resumed.round.deadlines).toEqual(playing.round.deadlines);
    expect(duplicate.sequence).toBe(playing.sequence);
    expect(start).toHaveBeenCalledTimes(1);
    expect(h.charges.size).toBe(1);
    expect(h.references.size).toBe(1);
  });

  it('repeating play after delayed confirmation completes the same entry without another start command', async () => {
    const { h, engine, start } = setup();
    const request = { type: 'play', commandId: 'stable-play-command' };
    const initial = await round(engine, alice, request);
    const retried = await round(engine, alice, request);
    expect(retried.round.id).toBe(initial.round.id);
    expect(retried.payment).toEqual(initial.payment);
    h.pay(initial.payment, alice.wallet);
    await h.flush();
    const playing = await round(engine, alice, request);
    expect(playing.round.id).toBe(initial.round.id);
    expect(playing.round.status).toBe('playing');
    expect(start).toHaveBeenCalledTimes(1);
    expect(h.tickets.size).toBe(1);
    expect(h.references.size).toBe(1);
  });

  it('returns a completed game directly when its automatic start produces a result', async () => {
    const h = createHarness();
    const engine = createP2PEngine({
      ...h,
      game: {
        ...wordsGame,
        start: () => ({
          status: 'finished' as const,
          state: { words: [], score: 0 },
          result: { score: 0, wordCount: 0 },
        }),
      },
    });
    h.connect(engine.webhook);
    const initial = await round(engine, alice, { type: 'play', commandId: 'play' });
    h.pay(initial.payment, alice.wallet);
    await h.flush();
    const completed = await round(engine, alice, { type: 'resume', roundId: initial.round.id });
    expect(completed.round).toMatchObject({
      status: 'finished', result: { score: 0, wordCount: 0 }, canAct: false,
    });
    expect(completed.payment).toBeNull();
    const resumed = await round(engine, alice, { type: 'resume', roundId: initial.round.id });
    expect(resumed).toEqual(completed);
  });

  it('resumes a start whose durable write succeeded but response was lost without restarting its clock', async () => {
    const { h, engine } = setup();
    const initial = await round(engine, alice, { type: 'play', commandId: 'play' });
    h.pay(initial.payment, alice.wallet);
    await h.flush();
    const interrupt = ({ value }: Record<string, unknown>) => {
      const entry = value as Round<unknown, unknown, unknown>;
      if (entry.kind === 'round' && entry.play) throw new Error('Response lost after start write');
      h.on('store.write.after', interrupt);
    };
    h.on('store.write.after', interrupt);
    await expect(engine.handle(alice, { type: 'resume', roundId: initial.round.id }))
      .rejects.toThrow('Response lost after start write');
    const committed = await round(engine, alice, { type: 'get', roundId: initial.round.id });
    expect(committed.round.status).toBe('playing');
    h.advance(1_000);
    const resumed = await round(engine, alice, { type: 'resume', roundId: initial.round.id });
    expect(resumed.round.deadlines).toEqual(committed.round.deadlines);
    expect(resumed.sequence).toBe(committed.sequence);
    expect(h.transfers).toHaveLength(0);
  });

  it.each(['before payment', 'confirmation gap', 'confirmed', 'playing'] as const)(
    'rejects cancellation %s without creating a refund obligation',
    async (phase) => {
      const { h, engine } = setup();
      const initial = await round(engine, alice, { type: 'play', commandId: 'play' });
      if (phase !== 'before payment') h.pay(initial.payment, alice.wallet);
      if (phase === 'confirmed' || phase === 'playing') await h.flush();
      if (phase === 'playing')
        await engine.handle(alice, { type: 'resume', roundId: initial.round.id });
      const before = { ...h.stats };
      await expect(engine.handle(alice, {
        type: 'cancel', roundId: initial.round.id, commandId: 'cancel',
      })).rejects.toMatchObject({ code: 'invalid_request' });
      expect(h.stats.writes).toBe(before.writes);
      expect(h.stats.creates).toBe(before.creates);
      if (phase === 'before payment') h.pay(initial.payment, alice.wallet);
      await h.flush();
      const active = await round(engine, alice, { type: 'resume', roundId: initial.round.id });
      expect(active.round).toMatchObject({ status: 'playing', paid: true, payout: null });
      expect(h.tickets.get(initial.round.id)?.state).toBe('waiting');
      expect(h.transfers).toHaveLength(0);
      expect(h.attempts.size).toBe(0);
    },
  );

  it('continues to honor a closed entry persisted by the previous API when payment arrives late', async () => {
    const { h, engine } = setup();
    const initial = await round(engine, alice, { type: 'play', commandId: 'old-intent' });
    const reference = h.references.get(initial.payment!.reference)!;
    const path = String(reference.meta.path);
    const stored = (await h.store.readJson<Round<unknown, unknown, unknown>>(path))!;
    await h.store.writeJson(path, {
      ...stored.value,
      revision: stored.value.revision + 1,
      cancelled: true,
      cancelRequested: true,
    }, stored.etag);
    const event = h.pay(initial.payment, alice.wallet);
    await h.flush();
    await h.deliver(event);
    const closed = await round(engine, alice, { type: 'resume', roundId: initial.round.id });
    expect(closed.round).toMatchObject({
      status: 'cancelled', game: null, payout: { kind: 'refund', status: 'paid' },
    });
    expect(closed.payment).toBeNull();
    expect(h.transfers.map((transfer) => transfer.recipients)).toEqual([
      [{ to: alice.wallet, amountCents: 100 }],
    ]);
    expect(h.matches.size).toBe(0);
  });

  it('keeps get and history pure and sanitized after the game deadline passes', async () => {
    const { h, engine } = setup();
    const initial = await round(engine, alice, { type: 'play', commandId: 'play' });
    h.pay(initial.payment, alice.wallet);
    await h.flush();
    const playing = await round(engine, alice, { type: 'resume', roundId: initial.round.id });
    h.advance(playing.round.deadlines.submission! - h.now() + 1);
    const before = { writes: h.stats.writes, creates: h.stats.creates, timers: h.timers.size, sends: h.sends.length };
    const current = await round(engine, alice, { type: 'get', roundId: initial.round.id });
    const history = await engine.handle(alice, { type: 'history' });
    expect(current.round).toMatchObject({ status: 'playing', canAct: false, result: null });
    expect(history).toMatchObject({ kind: 'history', rounds: [current.round], cursor: null });
    expect(JSON.stringify(history)).not.toContain('allowed');
    expect(JSON.stringify(history)).not.toContain('idempotencyKey');
    expect({ writes: h.stats.writes, creates: h.stats.creates, timers: h.timers.size, sends: h.sends.length }).toEqual(before);
  });

  it.each([
    null, [], {}, { type: 'enter', commandId: 'x' }, { type: 'start', roundId: 'x' },
    { type: 'reconcile', wallet: 'alice', roundId: 'x' }, { type: 'inspect', wallet: 'alice', roundId: 'x' },
    { type: 'play', commandId: '' }, { type: 'play', commandId: 'x', wallet: 'bob' },
    { type: 'history', limit: 0 }, { type: 'act', roundId: 'x', commandId: 'x', sequence: -1, action: {} },
  ])('rejects malformed or unsupported protocol request %j before storage effects', async (input) => {
    const { h, engine } = setup();
    await expect(engine.handle(alice, input)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(h.stats.writes).toBe(0);
    expect(h.stats.creates).toBe(0);
    expect(h.references.size).toBe(0);
  });
});

describe('standard authenticated HTTP binding', () => {
  it('uses verified actor identity and rejects access to another player’s entry', async () => {
    const { engine } = setup();
    const aliceHandler = createP2PHandler({ engine, authenticate: () => alice });
    const bobHandler = createP2PHandler({ engine, authenticate: () => bob });
    const response = await aliceHandler(post({ type: 'play', commandId: 'play' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const created = await response.json();
    const denied = await bobHandler(post({ type: 'get', roundId: created.round.id }));
    expect(denied.status).toBe(404);
    expect(await denied.json()).toMatchObject({ error: { code: 'not_found' } });
    const spoofed = await aliceHandler(post({ type: 'play', commandId: 'spoof', wallet: 'bob' }));
    expect(spoofed.status).toBe(400);
  });

  it('rejects unauthenticated calls before parsing or touching the engine', async () => {
    const handle = vi.fn();
    const handler = createP2PHandler({ engine: { handle }, authenticate: () => null });
    const response = await handler(new Request('https://game.example/api/game', { method: 'POST', body: '{' }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'unauthenticated' } });
    expect(handle).not.toHaveBeenCalled();
  });

  it('reports malformed JSON and unsupported methods without invoking a workflow', async () => {
    const { h, engine } = setup();
    const handler = createP2PHandler({ engine, authenticate: () => alice });
    const malformed = await handler(new Request('https://game.example/api/game', { method: 'POST', body: '{' }));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: 'invalid_json' } });
    const get = await handler(new Request('https://game.example/api/game'));
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect(h.stats.creates).toBe(0);
  });

  it('returns actionable command conflicts and keeps infrastructure details private', async () => {
    const { h, engine } = setup();
    const handler = createP2PHandler({ engine, authenticate: () => alice });
    await handler(post({ type: 'play', commandId: 'same-intent' }));
    const conflict = await handler(post({ type: 'play', commandId: 'same-intent', offerId: 'changed' }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'command_conflict' } });
    h.failNext('reference.after', new Error('Secret RPC connection details'));
    const unavailable = await handler(post({ type: 'play', commandId: 'new-intent' }));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      error: { code: 'service_unavailable', message: 'The game is temporarily unavailable.' },
    });
  });
});
