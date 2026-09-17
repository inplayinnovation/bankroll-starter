import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';

import { requireSession, Unauthorized } from '@joinbankroll/sdk/next';
import { PreconditionFailed } from '@joinbankroll/sdk/store';
import { storeDirectory } from '@joinbankroll/sdk/store/fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET as getGames, POST as postGame } from '@/app/api/games/route';
import { GET as getGame } from '@/app/api/games/[id]/route';
import { POST as postWord } from '@/app/api/games/[id]/words/route';
import { POST as postStart } from '@/app/api/games/[id]/start/route';
import { POST as postFinish } from '@/app/api/games/[id]/finish/route';
import {
  createGame,
  finishGame,
  gameView,
  listGames,
  readGame,
  startGame,
  submitWord,
} from '@/lib/games';
import { storeBackend } from '@/lib/store';
import { ROUND_MS } from '@/lib/word-hunt';

// The SDK tests token verification. Here a verified wallet is the boundary:
// route tests deliberately send conflicting identity and game facts in bodies.
vi.mock('@joinbankroll/sdk/next', () => ({
  requireSession: vi.fn(),
  Unauthorized: class Unauthorized extends Error {},
}));

const wallets: string[] = [];
let wallet: string;
let now: number;
const board = ['C', 'A', 'T', 'S', 'D', 'O', 'G', 'E', 'QU', 'I', 'Z', 'R', 'B', 'A', 'L', 'L'];
const pathFor = (id: string) => `games/${wallet}/${id}.json`;

beforeAll(() => {
  // Assert isolation here as well: no writing fixture runs on an unsafe store,
  // even when this file is selected without environment.test.ts.
  expect(process.env.NODE_ENV).toBe('test');
  expect(['fs', 'blob']).toContain(process.env.STORE);
  if (process.env.STORE === 'fs') expect(storeDirectory()).toBe('bankroll/test');
  else {
    expect(process.env.DANGEROUS_BLOB_TOKEN).toBeTruthy();
    expect(process.env.BLOB_READ_WRITE_TOKEN).toBe(process.env.DANGEROUS_BLOB_TOKEN);
  }
});

beforeEach(() => {
  wallet = `word-hunt-test-${randomUUID()}`;
  wallets.push(wallet);
  now = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.mocked(requireSession).mockResolvedValue({
    iss: 'test',
    aud: 'http://localhost',
    iat: now / 1000,
    exp: now / 1000 + 3600,
    user: { wallet, username: 'tester', identity: false },
  });
});

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  if (process.env.STORE === 'fs' && storeDirectory() === 'bankroll/test') {
    // Only this run's wallet directories, never the shared test root.
    await Promise.all(
      wallets.map((owner) =>
        rm(`${storeDirectory()}/games/${owner}`, { recursive: true, force: true }),
      ),
    );
  }
});

async function fixture() {
  const game = await createGame(wallet);
  const stored = await storeBackend().readJson(pathFor(game.id));
  await storeBackend().writeJson(pathFor(game.id), { ...game, board }, stored!.etag);
  return startGame(wallet, game.id);
}

function request(body?: unknown) {
  return new Request('http://localhost/api/games', {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const context = (id: string) => ({ params: Promise.resolve({ id }) });

describe('round lifecycle', () => {
  it('prepares without revealing the board or starting the clock', async () => {
    const game = await createGame(wallet);
    expect(game.board).toHaveLength(16);
    expect(gameView(game)).toMatchObject({
      status: 'ready',
      board: [],
      startedAt: null,
      endsAt: null,
    });
    expect(gameView(game)).not.toHaveProperty('seed');
    now += ROUND_MS * 2;
    expect((await readGame(wallet, game.id)).status).toBe('ready');
  });

  it('starts once, including racing starts and a replay after expiry', async () => {
    const game = await createGame(wallet);
    const results = await Promise.all([startGame(wallet, game.id), startGame(wallet, game.id)]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].endsAt).toBe(now + ROUND_MS);
    now += 5_000;
    expect(await startGame(wallet, game.id)).toEqual(results[0]);
    now = results[0].endsAt!;
    expect(await startGame(wallet, game.id)).toMatchObject({
      status: 'finished',
      endedBy: 'time',
      finishedAt: now,
    });
  });

  it('only reads or mutates rounds under the verified wallet', async () => {
    const game = await fixture();
    for (const action of [readGame, startGame, finishGame]) {
      await expect(action('someone-else', game.id)).rejects.toMatchObject({ status: 404 });
    }
    await expect(submitWord('someone-else', game.id, 1, [0, 1, 2])).rejects.toMatchObject({
      status: 404,
    });
    await expect(readGame(wallet, '../someone-else')).rejects.toMatchObject({ status: 404 });
  });

  it('ends early once and cannot gain points or restart afterward', async () => {
    const game = await fixture();
    const finished = await finishGame(wallet, game.id);
    now += 500;
    expect(await finishGame(wallet, game.id)).toEqual(finished);
    expect(await startGame(wallet, game.id)).toEqual(finished);
    expect(await submitWord(wallet, game.id, 1, [0, 1, 2])).toEqual(finished);
    expect(finished).toMatchObject({ status: 'finished', endedBy: 'player', score: 0 });
  });
});

describe('authoritative submissions', () => {
  it('derives the word and score from the stored board', async () => {
    const game = await fixture();
    const scored = await submitWord(wallet, game.id, 1, [0, 1, 2]);
    expect(scored).toMatchObject({
      score: 1,
      words: ['CAT'],
      submissions: 1,
      lastSubmission: { sequence: 1, word: 'CAT', points: 1, outcome: 'accepted' },
    });
  });

  it('collapses concurrent submissions with the same sequence', async () => {
    const game = await fixture();
    const responses = await Promise.all([
      submitWord(wallet, game.id, 1, [0, 1, 2]),
      submitWord(wallet, game.id, 1, [4, 5, 6]),
    ]);
    expect(responses[0]).toEqual(responses[1]);
    expect(responses[0].score).toBe(1);
    expect(responses[0].words).toHaveLength(1);
  });

  it('returns current state for a replay, even with an old or different payload', async () => {
    const game = await fixture();
    await submitWord(wallet, game.id, 1, [0, 1, 2]);
    const current = await submitWord(wallet, game.id, 2, [4, 5, 6]);
    expect(await submitWord(wallet, game.id, 1, null)).toEqual(current);
    expect(current.score).toBe(2);
  });

  it('scores a word once even when sent with a new sequence', async () => {
    const game = await fixture();
    await submitWord(wallet, game.id, 1, [0, 1, 2]);
    const repeated = await submitWord(wallet, game.id, 2, [0, 1, 2]);
    expect(repeated).toMatchObject({
      score: 1,
      submissions: 2,
      words: ['CAT'],
      lastSubmission: { outcome: 'already_found', points: 0 },
    });
  });

  it('records a rejected word once and permits the next submission', async () => {
    const game = await fixture();
    const rejected = await submitWord(wallet, game.id, 1, [0, 4, 8]);
    expect(rejected).toMatchObject({
      score: 0,
      submissions: 1,
      lastSubmission: { outcome: 'not_word' },
    });
    expect(await submitWord(wallet, game.id, 1, [0, 4, 8])).toEqual(rejected);
    expect((await submitWord(wallet, game.id, 2, [0, 1, 2])).score).toBe(1);
  });

  it('rejects skipped sequences and malformed paths without changing the document', async () => {
    const game = await fixture();
    await expect(submitWord(wallet, game.id, 2, [0, 1, 2])).rejects.toMatchObject({
      code: 'out_of_sequence',
      status: 409,
    });
    for (const path of [null, [], [0, 1, 0], [3, 4], [16], ['0'], [null], [0.5]]) {
      await expect(submitWord(wallet, game.id, 1, path)).rejects.toMatchObject({
        code: 'invalid_path',
        status: 400,
      });
    }
    for (const sequence of [0, -1, 1.5, '1', null, NaN, Infinity]) {
      await expect(submitWord(wallet, game.id, sequence, [0, 1, 2])).rejects.toMatchObject({
        code: 'invalid_sequence',
        status: 400,
      });
    }
    expect(await readGame(wallet, game.id)).toEqual(game);
  });

  it('accepts just before the deadline and refuses points exactly at it', async () => {
    const game = await fixture();
    now = game.endsAt! - 1;
    expect((await submitWord(wallet, game.id, 1, [0, 1, 2])).score).toBe(1);
    now++;
    expect(await submitWord(wallet, game.id, 2, [4, 5, 6])).toMatchObject({
      status: 'finished',
      score: 1,
      submissions: 1,
      endedBy: 'time',
      finishedAt: now,
    });
  });

  it('rechecks the deadline after losing a compare-and-swap', async () => {
    const game = await fixture();
    vi.spyOn(storeBackend(), 'writeJson').mockImplementationOnce(async (path) => {
      now = game.endsAt!;
      throw new PreconditionFailed(path);
    });
    expect(await submitWord(wallet, game.id, 1, [0, 1, 2])).toMatchObject({
      status: 'finished',
      score: 0,
      submissions: 0,
    });
  });

  it('serializes a finish racing a word on the same document', async () => {
    const game = await fixture();
    await Promise.all([finishGame(wallet, game.id), submitWord(wallet, game.id, 1, [0, 1, 2])]);
    const current = await readGame(wallet, game.id);
    expect(current.status).toBe('finished');
    expect(current.score).toBe(current.words.length);
    expect(current.submissions).toBe(current.words.length);
  });
});

describe('history', () => {
  it('leaves incompatible records untouched and out of the current history', async () => {
    const old = await createGame(wallet);
    const legacy = {
      id: old.id,
      seed: 'previous-format',
      board,
      words: [{ word: 'CAT', points: 1 }],
      status: 'finished',
      startedAt: new Date(now).toISOString(),
      endsAt: new Date(now + ROUND_MS).toISOString(),
      endedAt: new Date(now + ROUND_MS).toISOString(),
    };
    const stored = await storeBackend().readJson(pathFor(old.id));
    await storeBackend().writeJson(pathFor(old.id), legacy, stored!.etag);
    now++;
    const current = await createGame(wallet);

    expect((await listGames(wallet)).games.map((game) => game.id)).toEqual([current.id]);
    for (const action of [readGame, startGame, finishGame]) {
      await expect(action(wallet, old.id)).rejects.toMatchObject({ status: 404 });
    }
    await expect(submitWord(wallet, old.id, 1, [0, 1, 2])).rejects.toMatchObject({ status: 404 });
    expect((await storeBackend().readJson(pathFor(old.id)))?.value).toEqual(legacy);
  });

  it('refuses versions it does not implement', async () => {
    const game = await createGame(wallet);
    const stored = await storeBackend().readJson(pathFor(game.id));
    await storeBackend().writeJson(pathFor(game.id), { ...game, rulesVersion: 2 }, stored!.etag);
    expect((await listGames(wallet)).games).toEqual([]);
    await expect(startGame(wallet, game.id)).rejects.toMatchObject({ status: 404 });
  });

  it('paginates newest first within one wallet', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 21; i++) {
      now++;
      ids.unshift((await createGame(wallet)).id);
    }
    const first = await listGames(wallet);
    expect(first.games.map((game) => game.id)).toEqual(ids.slice(0, 20));
    expect(first.cursor).toBeTruthy();
    const second = await listGames(wallet, first.cursor);
    expect(second.games.map((game) => game.id)).toEqual(ids.slice(20));
    expect(second.cursor).toBeUndefined();
    expect((await listGames('someone-else')).games).toEqual([]);
  });

  it('finalizes expired rounds on a history read without a background worker', async () => {
    const game = await fixture();
    now = game.endsAt! + 30_000;
    const page = await listGames(wallet);
    expect(page.games[0]).toMatchObject({ id: game.id, status: 'finished', score: 0 });
    expect(await readGame(wallet, game.id)).toMatchObject({
      finishedAt: game.endsAt,
      endedBy: 'time',
    });
  });
});

describe('HTTP boundary', () => {
  it('requires a verified session before any endpoint reads or writes', async () => {
    vi.mocked(requireSession).mockRejectedValue(new Unauthorized());
    const read = vi.spyOn(storeBackend(), 'readJson');
    const create = vi.spyOn(storeBackend(), 'createIfAbsent');
    const list = vi.spyOn(storeBackend(), 'list');
    const responses = await Promise.all([
      getGames(request()),
      postGame(request({})),
      getGame(request(), context('anything')),
      postStart(request({}), context('anything')),
      postWord(request({}), context('anything')),
      postFinish(request({}), context('anything')),
    ]);
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401, 401, 401]);
    expect(read).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('ignores forged ownership, seed, and time at creation', async () => {
    const response = await postGame(
      request({ wallet: 'someone-else', seed: 42, startedAt: 0, endsAt: Number.MAX_SAFE_INTEGER }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const { game, serverNow } = await response.json();
    expect(serverNow).toBe(now);
    expect(game).toMatchObject({
      score: 0,
      status: 'ready',
      board: [],
      startedAt: null,
      endsAt: null,
    });
    expect(game).not.toHaveProperty('seed');
    expect((await readGame(wallet, game.id)).createdAt).toBe(now);
    await expect(readGame('someone-else', game.id)).rejects.toMatchObject({ status: 404 });
  });

  it('ignores client word, score, and timestamps; validates the path instead', async () => {
    const game = await fixture();
    const response = await postWord(
      request({
        sequence: 1,
        path: [0, 1, 2],
        wallet: 'someone-else',
        word: 'STACKING',
        score: 999,
        now: 0,
        endsAt: Number.MAX_SAFE_INTEGER,
      }),
      context(game.id),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).game).toMatchObject({
      score: 1,
      endsAt: game.endsAt,
      wordCount: 1,
      lastSubmission: { word: 'CAT' },
    });
  });

  it('returns 404 for another wallet and 400 for malformed JSON', async () => {
    const other = `word-hunt-test-${randomUUID()}`;
    wallets.push(other);
    const game = await createGame(other);
    expect((await getGame(request(), context(game.id))).status).toBe(404);
    const bad = new Request('http://localhost/api/games', { method: 'POST', body: '{' });
    expect((await postWord(bad, context(game.id))).status).toBe(400);
  });
});
