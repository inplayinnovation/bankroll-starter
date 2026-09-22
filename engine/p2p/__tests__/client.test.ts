import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createP2PClient, type P2PClientOptions } from '../client';
import type { EngineReply, EngineRequest, RoundReply } from '../protocol';

const clients: Array<{ dispose(): void }> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => {
  clients.splice(0).forEach((client) => client.dispose());
  vi.useRealTimers();
});

function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

function fixture() {
  const storage = memory();
  const requests: EngineRequest[] = [];
  const charge = vi.fn(async () => {});
  const reply: RoundReply<{ score: number }, { score: number }> = {
    kind: 'round',
    sequence: 0,
    payment: {
      amountCents: 100,
      reference: 'reference',
      memo: 'Entry',
      idempotencyKey: 'charge-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    round: {
      id: 'round-1',
      gameId: 'test',
      version: 1,
      createdAt: Date.now(),
      status: 'starting',
      entryCents: 100,
      paid: false,
      opponent: 'waiting',
      game: null,
      result: null,
      canAct: false,
      outcome: null,
      payout: null,
      issue: null,
      deadlines: { queue: null, start: null, play: null, submission: null },
    },
  };
  let respond: (
    input: EngineRequest,
  ) => EngineReply<{ score: number }, { score: number }> | Response | Promise<Response> = (
    input,
  ) => {
    if (input.type === 'resume' && reply.round.paid) {
      reply.round.status = 'playing';
      reply.round.canAct = true;
      reply.round.game = { score: 0 };
      reply.sequence = 1;
    }
    return reply;
  };
  function browser(options: Partial<P2PClientOptions> = {}) {
    const client = createP2PClient<{ score: number }, { score: number }>({
      endpoint: '/api/game',
      storage,
      charge,
      pollIntervalMs: 10,
      confirmationTimeoutMs: 30,
      requestTimeoutMs: 50,
      fetch: async (_url, init) => {
        const input = JSON.parse(String(init?.body)) as EngineRequest;
        requests.push(input);
        const value = await respond(input);
        return value instanceof Response ? value : Response.json(value);
      },
      ...options,
    });
    clients.push(client);
    return client;
  }
  return {
    browser,
    reply,
    requests,
    charge,
    storage,
    respond(value: typeof respond) {
      respond = value;
    },
  };
}

describe('player workflow failure and cleanup behavior', () => {
  it('does not persist an invalid deep link that would block later play', async () => {
    const f = fixture();
    f.respond(() =>
      Response.json({ error: { code: 'not_found', message: 'Round not found' } }, { status: 404 }),
    );
    const first = f.browser();
    await expect(first.resume('missing')).rejects.toMatchObject({ code: 'not_found' });
    first.dispose();
    f.reply.round.paid = true;
    f.reply.round.status = 'playing';
    f.respond(() => f.reply);
    expect((await f.browser().play()).status).toBe('playing');
    expect(f.requests.filter((input) => input.type === 'play')).toHaveLength(1);
  });

  it('allows a valid offer after the server definitively rejects an unknown one', async () => {
    const f = fixture();
    f.respond(() =>
      Response.json(
        { error: { code: 'unknown_offer', message: 'Unknown offer' } },
        { status: 400 },
      ),
    );
    const first = f.browser();
    await expect(first.play({ offerId: 'missing' })).rejects.toMatchObject({
      code: 'unknown_offer',
    });
    first.dispose();
    f.reply.round.paid = true;
    f.reply.round.status = 'playing';
    f.respond(() => f.reply);
    expect((await f.browser().play()).status).toBe('playing');
    const attempts = f.requests.filter((input) => input.type === 'play');
    expect(attempts.map((input) => input.offerId)).toEqual(['missing', 'default']);
    expect(new Set(attempts.map((input) => input.commandId)).size).toBe(2);
  });

  it('keeps a known payment across confirmation timeout and reload without opening another sheet', async () => {
    const f = fixture();
    const first = f.browser();
    const result = expect(first.play()).rejects.toMatchObject({ code: 'confirmation_pending' });
    await vi.advanceTimersByTimeAsync(40);
    await result;
    expect(f.charge).toHaveBeenCalledTimes(1);
    expect(first.getSnapshot()).toMatchObject({ phase: 'error', round: { paid: false } });
    first.dispose();
    const restored = f.browser();
    f.reply.round.paid = true;
    const round = await restored.resume();
    expect(round.status).toBe('playing');
    expect(f.charge).toHaveBeenCalledTimes(1);
    expect(f.requests.filter((input) => input.type === 'play')).toHaveLength(1);
  });

  it.each(['payment_denied', 'host_response_lost'])(
    'retains the same entry and charge key after %s',
    async (code) => {
      const f = fixture();
      f.charge.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      const first = f.browser();
      await expect(first.play()).rejects.toMatchObject({ code });
      first.dispose();
      f.charge.mockImplementationOnce(async () => {
        f.reply.round.paid = true;
      });
      const restored = f.browser();
      const resumed = restored.resume();
      await vi.advanceTimersByTimeAsync(10);
      expect((await resumed).status).toBe('playing');
      expect(f.charge).toHaveBeenCalledTimes(2);
      expect(f.charge.mock.calls[0]).toEqual(f.charge.mock.calls[1]);
      expect(f.requests.filter((input) => input.type === 'play')).toHaveLength(1);
    },
  );

  it('retries a lost entry response with the original identity after reload', async () => {
    const f = fixture();
    f.respond(() => {
      throw new Error('connection lost');
    });
    const first = f.browser();
    const failed = expect(first.play()).rejects.toThrow('connection lost');
    await vi.advanceTimersByTimeAsync(800);
    await failed;
    first.dispose();
    f.reply.round.paid = true;
    f.reply.round.status = 'playing';
    f.respond(() => f.reply);
    await f.browser().resume();
    const attempts = f.requests.filter((input) => input.type === 'play');
    expect(attempts).toHaveLength(4);
    expect(new Set(attempts.map((input) => input.commandId)).size).toBe(1);
    expect(f.charge).not.toHaveBeenCalled();
  });

  it('does not discard an unresolved entry when another round is selected', async () => {
    const f = fixture();
    f.charge.mockRejectedValueOnce(new Error('sheet interrupted'));
    const client = f.browser();
    await expect(client.play()).rejects.toThrow('sheet interrupted');
    await expect(client.resume('round-2')).rejects.toMatchObject({ code: 'active_entry' });
    expect(f.requests.some((input) => 'roundId' in input && input.roundId === 'round-2')).toBe(
      false,
    );
    f.reply.round.paid = true;
    expect((await client.resume()).id).toBe('round-1');
    expect(f.charge).toHaveBeenCalledTimes(1);
  });

  it('fails before creating an entry if its command identity cannot be saved', async () => {
    const f = fixture();
    const client = f.browser({
      storage: {
        ...f.storage,
        setItem() {
          throw new Error('storage unavailable');
        },
      },
    });
    await expect(client.play()).rejects.toThrow('storage unavailable');
    expect(f.requests).toHaveLength(0);
    expect(f.charge).not.toHaveBeenCalled();
  });

  it('stops a hung fetch and its retries on disposal, even if transport ignores the signal', async () => {
    const f = fixture();
    let signal: AbortSignal | null | undefined;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      signal = init?.signal;
      return new Promise(() => {});
    });
    const client = f.browser({ fetch: fetcher });
    const result = expect(client.play()).rejects.toMatchObject({ code: 'disposed' });
    await vi.advanceTimersByTimeAsync(0);
    client.dispose();
    await result;
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(f.charge).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a hung request without losing the retained entry identity', async () => {
    const f = fixture();
    const fetcher = vi.fn<typeof fetch>(async () => new Promise(() => {}));
    const client = f.browser({ fetch: fetcher });
    const failed = expect(client.play()).rejects.toMatchObject({ code: 'request_timeout' });
    await vi.advanceTimersByTimeAsync(1_000);
    await failed;
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    const inputs = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(new Set(inputs.map((input) => input.commandId)).size).toBe(1);
  });

  it('does not continue the workflow after a disposed payment sheet eventually resolves', async () => {
    const f = fixture();
    let resolve!: () => void;
    f.charge.mockImplementation(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const first = f.browser();
    const failed = expect(first.play()).rejects.toMatchObject({ code: 'disposed' });
    await vi.advanceTimersByTimeAsync(0);
    first.dispose();
    await failed;
    resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.requests).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    f.reply.round.paid = true;
    expect((await f.browser().resume()).status).toBe('playing');
    expect(f.charge).toHaveBeenCalledTimes(1);
  });

  it('keeps gameplay visible after rejected input and continues observing read-only state', async () => {
    const f = fixture();
    f.reply.round.paid = true;
    const client = f.browser();
    await client.play();
    f.respond((input) =>
      input.type === 'act'
        ? Response.json(
            { error: { code: 'invalid_action', message: 'Not a valid word' } },
            { status: 400 },
          )
        : f.reply,
    );
    await expect(client.act({ word: 'nope' })).rejects.toMatchObject({ code: 'invalid_action' });
    expect(client.getSnapshot()).toMatchObject({
      phase: 'playing',
      error: { code: 'invalid_action' },
    });
    f.requests.length = 0;
    await vi.advanceTimersByTimeAsync(20);
    expect(f.requests.length).toBeGreaterThan(0);
    expect(f.requests.every((input) => input.type === 'get')).toBe(true);
    client.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a stale observation arriving after a newer action response', async () => {
    const f = fixture();
    f.reply.round.paid = true;
    const client = f.browser();
    await client.play();
    let resolve!: (response: Response) => void;
    const stale = Response.json(f.reply);
    f.respond((input) => {
      if (input.type === 'get')
        return new Promise<Response>((done) => {
          resolve = done;
        });
      f.reply.round.game = { score: 10 };
      f.reply.sequence++;
      return f.reply;
    });
    await vi.advanceTimersByTimeAsync(10);
    await client.act({ score: 10 });
    resolve(stale);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getSnapshot().round?.game).toEqual({ score: 10 });
  });
});
