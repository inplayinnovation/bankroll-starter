import { afterEach, describe, expect, it } from 'vitest';

import { createP2PClient, type P2PClientOptions } from '../client';
import { createP2PEngine } from '../engine';
import { createP2PHandler } from '../http';
import { shootingGame, simulateShot } from '../examples/shooting';
import { wordsGame } from '../examples/words';
import type { EngineReply, EngineRequest } from '../protocol';
import type { Actor, GameDefinition, RoundView } from '../types';
import { createHarness } from './harness';

const alice = { wallet: 'alice' };
const bob = { wallet: 'bob' };
const clients: Array<{ dispose(): void }> = [];
afterEach(() => { clients.splice(0).forEach((client) => client.dispose()); });

function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

function fixture<C, S, A, R, V>(game: GameDefinition<C, S, A, R, V>) {
  const h = createHarness();
  const engine = createP2PEngine({ ...h, game });
  h.connect(engine.webhook);
  const requests: Array<{ actor: Actor; input: EngineRequest }> = [];
  const charges: string[] = [];
  function browser(actor: Actor, settings: P2PClientOptions & {
    before?: (input: EngineRequest) => Promise<void>;
    after?: (input: EngineRequest, response: Response) => Promise<Response>;
  } = { endpoint: 'https://engine.example.test/api/game' }) {
    const handler = createP2PHandler({ engine, authenticate: () => actor });
    const client = createP2PClient<V, R>({
      storage: memory(),
      pollIntervalMs: 5,
      confirmationTimeoutMs: 2_000,
      requestTimeoutMs: 2_000,
      fetch: async (_url, init) => {
        const input = JSON.parse(String(init?.body)) as EngineRequest;
        requests.push({ actor, input });
        await settings.before?.(input);
        const response = await handler(new Request(settings.endpoint, init));
        return settings.after ? settings.after(input, response) : response;
      },
      charge: async (payment) => {
        charges.push(payment.idempotencyKey);
        h.pay(payment, actor.wallet);
        await h.flush();
      },
      ...settings,
    });
    clients.push(client);
    return client;
  }
  return { h, engine, browser, requests, charges };
}

function assertPlayerProjection<V, R>(round: RoundView<V, R>) {
  expect(round).not.toHaveProperty('payment');
  expect(round).not.toHaveProperty('sequence');
  expect(round).not.toHaveProperty('allowed');
  expect(['initializing', 'awaiting_payment', 'ready']).not.toContain(round.status);
}

describe('browser workflow through the real engine and authenticated transport', () => {
  it('starts automatically after a delayed payment webhook, with one charge for concurrent Play calls', async () => {
    const f = fixture(wordsGame);
    let reads = 0;
    let chargeCount = 0;
    const phases: string[] = [];
    const client = f.browser(alice, {
      endpoint: 'https://engine.example.test/api/game',
      charge: async (payment) => {
        chargeCount++;
        f.h.pay(payment, alice.wallet);
      },
      before: async (input) => {
        if (input.type === 'get' && ++reads === 3) await f.h.flush();
      },
    });
    client.subscribe(() => {
      phases.push(client.getSnapshot().phase);
      const round = client.getSnapshot().round;
      if (round) assertPlayerProjection(round);
    });
    const first = client.play();
    const second = client.play();
    expect(second).toBe(first);
    const round = await first;
    expect(round.status).toBe('playing');
    expect(round.game?.score).toBe(0);
    expect(chargeCount).toBe(1);
    expect(f.h.tickets.size).toBe(1);
    expect(new Set(phases)).toEqual(new Set(['starting', 'playing']));
    expect(f.requests.map(({ input }) => input.type)).toContain('resume');
    expect(f.requests.some(({ input }) => ['start', 'enter', 'cancel'].includes(input.type))).toBe(false);
    expect(client).not.toHaveProperty('start');
    expect(client).not.toHaveProperty('cancel');
  });

  it('plays and settles a word game with action identities and sequences supplied entirely by the client', async () => {
    const f = fixture(wordsGame);
    const a = f.browser(alice);
    const b = f.browser(bob);
    const first = await a.play();
    const second = await b.play();
    const path = [...'CAT'].map((letter) => first.game!.board.indexOf(letter));
    const scored = await a.act({ type: 'word', path });
    expect(scored.game?.score).toBe(1);
    await a.act({ type: 'finish' });
    await b.act({ type: 'finish' });
    await f.h.flush();
    const winner = await a.get(first.id);
    const loser = await b.get(second.id);
    expect(winner.outcome).toEqual({ kind: 'win', amountCents: 180 });
    expect(loser.outcome).toEqual({ kind: 'loss', amountCents: 0 });
    expect(winner.payout?.status).toBe('paid');
    expect(f.h.transfers).toHaveLength(1);
    const actions = f.requests.filter(({ input }) => input.type === 'act');
    expect(actions).toHaveLength(3);
    expect(new Set(actions.map(({ input }) => input.type === 'act' && input.commandId)).size).toBe(3);
    actions.forEach(({ input }) => {
      if (input.type === 'act') expect(input.sequence).toBeGreaterThan(0);
    });
    (await a.history()).rounds.forEach(assertPlayerProjection);
  });

  it('uses the same player lifecycle for a bounded shooting replay', async () => {
    const f = fixture(shootingGame);
    const a = f.browser(alice);
    const b = f.browser(bob);
    const first = await a.play();
    const second = await b.play();
    expect(first.game!.distanceCm).toBe(second.game!.distanceCm);
    const challenge = { distanceCm: first.game!.distanceCm };
    let speedMps = 7;
    while (!simulateShot(challenge, { atMs: 0, angleDeg: 45, speedMps }).made && speedMps < 10)
      speedMps += 0.01;
    expect(speedMps).toBeLessThan(10);
    f.h.advance(16_000);
    await a.act({ type: 'replay', shots: [{ atMs: 0, angleDeg: 45, speedMps }] });
    await b.act({ type: 'replay', shots: [] });
    await f.h.flush();
    expect((await a.get(first.id)).result).toEqual({ score: 2, attempts: 1 });
    expect((await a.get(first.id)).outcome).toEqual({ kind: 'win', amountCents: 180 });
    expect(f.h.transfers).toHaveLength(1);
  });

  it('resumes an accepted start after losing all responses without charging again or restarting the clock', async () => {
    const f = fixture(wordsGame);
    const storage = memory();
    const first = f.browser(alice, {
      endpoint: 'https://engine.example.test/api/game',
      storage,
      after: async (input, response) => {
        if (input.type === 'resume') throw new Error('Lost start response');
        return response;
      },
    });
    await expect(first.play()).rejects.toThrow('Lost start response');
    const roundId = first.getSnapshot().round!.id;
    const started = await f.engine.handle(alice, { type: 'get', roundId });
    expect(started.kind).toBe('round');
    const deadline = started.kind === 'round' ? started.round.deadlines.play : null;
    first.dispose();
    f.h.advance(1_000);
    const restored = f.browser(alice, { endpoint: 'https://engine.example.test/api/game', storage });
    const round = await restored.resume();
    expect(round.id).toBe(roundId);
    expect(round.status).toBe('playing');
    expect(round.deadlines.play).toBe(deadline);
    expect(f.charges).toHaveLength(1);
    expect(f.h.tickets.size).toBe(1);
  });

  it('rejects cancellation even while a successful payment is waiting for its webhook', async () => {
    const f = fixture(wordsGame);
    let release!: () => void;
    const charged = new Promise<void>((resolve) => { release = resolve; });
    const client = f.browser(alice, {
      endpoint: 'https://engine.example.test/api/game',
      charge: async (payment) => {
        f.h.pay(payment, alice.wallet);
        release();
      },
    });
    const playing = client.play();
    await charged;
    const roundId = client.getSnapshot().round!.id;
    const handler = createP2PHandler({ engine: f.engine, authenticate: () => alice });
    const cancel = () => handler(new Request('https://engine.example.test/api/game', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'cancel', roundId, commandId: 'cancel' }),
    }));
    expect((await cancel()).status).toBe(400);
    await f.h.flush();
    expect((await playing).status).toBe('playing');
    expect((await cancel()).status).toBe(400);
    expect(f.h.transfers).toHaveLength(0);
    expect(f.h.tickets.get(roundId)?.state).toBe('waiting');
    const result: EngineReply<unknown, unknown> = await f.engine.handle(alice, { type: 'get', roundId });
    expect(result.kind === 'round' && result.round.paid).toBe(true);
  });

  it('resumes elapsed gameplay through the server while ordinary reads remain pure', async () => {
    const f = fixture(wordsGame);
    const storage = memory();
    const first = f.browser(alice, { endpoint: 'https://engine.example.test/api/game', storage });
    const started = await first.play();
    first.dispose();
    f.h.advance(wordsGame.durationMs);
    // Delivery can lag. Reading the entry does not advance its game state.
    const unchanged = await f.engine.handle(alice, { type: 'get', roundId: started.id });
    expect(unchanged.kind === 'round' && unchanged.round.status).toBe('playing');
    const restored = f.browser(alice, { endpoint: 'https://engine.example.test/api/game', storage });
    const resumed = await restored.resume();
    expect(resumed.status).toBe('finished');
    expect(resumed.result).toEqual({ score: 0, wordCount: 0 });
    expect(f.charges).toHaveLength(1);
  });

  it('clears a saved action after its lost rejection is definitively recovered on reconnect', async () => {
    const f = fixture(wordsGame);
    const storage = memory();
    const first = f.browser(alice, {
      endpoint: 'https://engine.example.test/api/game',
      storage,
      after: async (input, response) => {
        if (input.type === 'act') throw new Error('Lost rejection response');
        return response;
      },
    });
    await first.play();
    await expect(first.act({ type: 'word', path: [99] })).rejects.toThrow('Lost rejection response');
    first.dispose();
    const restored = f.browser(alice, { endpoint: 'https://engine.example.test/api/game', storage });
    expect((await restored.resume()).status).toBe('playing');
    const finished = await restored.act({ type: 'finish' });
    expect(finished.status).toBe('finished');
    expect(f.charges).toHaveLength(1);
  });

  it('replays an accepted action after all replies were lost without scoring twice and continues with the new sequence', async () => {
    const f = fixture(wordsGame);
    const storage = memory();
    const first = f.browser(alice, {
      endpoint: 'https://engine.example.test/api/game',
      storage,
      after: async (input, response) => {
        if (input.type === 'act') throw new Error('Lost accepted action response');
        return response;
      },
    });
    const started = await first.play();
    const path = [...'CAT'].map((letter) => started.game!.board.indexOf(letter));
    await expect(first.act({ type: 'word', path })).rejects.toThrow('Lost accepted action response');
    const accepted = await f.engine.handle(alice, { type: 'get', roundId: started.id });
    expect(accepted.kind === 'round' && accepted.round.game?.score).toBe(1);
    first.dispose();

    const restored = f.browser(alice, { endpoint: 'https://engine.example.test/api/game', storage });
    const recovered = await restored.resume();
    expect(recovered.status).toBe('playing');
    expect(recovered.game).toMatchObject({ score: 1, words: ['CAT'] });
    const finished = await restored.act({ type: 'finish' });
    expect(finished.result).toEqual({ score: 1, wordCount: 1 });

    const actions = f.requests
      .map(({ input }) => input)
      .filter((input): input is Extract<EngineRequest, { type: 'act' }> => input.type === 'act');
    // Three failed-response attempts plus a reload replay share one accepted command.
    expect(actions).toHaveLength(5);
    actions.slice(0, 4).forEach((input) => expect(input).toEqual(actions[0]));
    expect(actions[4].commandId).not.toBe(actions[0].commandId);
    expect(actions[4].sequence).toBe(actions[0].sequence + 1);
    expect(f.charges).toHaveLength(1);
  });
});
