import { randomInt, randomUUID } from 'node:crypto';

import { PreconditionFailed, sortableId, TooContended } from '@joinbankroll/sdk/store';

import { storeBackend } from '@/lib/store';
import { boardFromSeed } from '@/lib/word-hunt-board';
import { isWord } from '@/lib/word-hunt-dictionary';
import {
  pointsForWord,
  ROUND_MS,
  RULES_VERSION,
  wordForPath,
  type GameSummary,
  type GameView,
} from '@/lib/word-hunt';

export interface GameDocument extends Omit<GameView, 'wordCount'> {
  seed: number;
  words: string[];
}

export class GameError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
  }
}

const ID_PATTERN = /^\d{16}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const prefix = (wallet: string) => `games/${encodeURIComponent(wallet)}/`;
function gamePath(wallet: string, id: string) {
  if (!ID_PATTERN.test(id)) throw new GameError('game_not_found', 404);
  return `${prefix(wallet)}${id}.json`;
}

export function gameView(game: GameDocument): GameView {
  return {
    id: game.id,
    rulesVersion: game.rulesVersion,
    status: game.status,
    createdAt: game.createdAt,
    startedAt: game.startedAt,
    endsAt: game.endsAt,
    finishedAt: game.finishedAt,
    endedBy: game.endedBy,
    // A prepared round must not reveal its puzzle before the clock starts.
    board: game.status === 'ready' ? [] : game.board,
    score: game.score,
    wordCount: game.words.length,
    submissions: game.submissions,
    lastSubmission: game.lastSubmission,
  };
}

function expire(game: GameDocument): GameDocument {
  if (game.status !== 'playing' || game.endsAt === null || Date.now() < game.endsAt) return game;
  return { ...game, status: 'finished', finishedAt: game.endsAt, endedBy: 'time' };
}

/** Every transition, including expiry, competes on this one document. */
async function changeGame(
  wallet: string,
  id: string,
  change: (game: GameDocument) => GameDocument,
): Promise<GameDocument> {
  const path = gamePath(wallet, id);
  const backend = storeBackend();
  for (let attempt = 0; attempt < 5; attempt++) {
    const stored = await backend.readJson<GameDocument>(path);
    // Persisted JSON can outlive the code that wrote it. Never interpret an
    // unsupported document as this version's round, or transition its state.
    if (!stored || stored.value.rulesVersion !== RULES_VERSION) {
      throw new GameError('game_not_found', 404);
    }
    // Recheck the deadline and sequence on every CAS retry. A losing writer
    // cannot carry a stale decision past another word, finish, or deadline.
    const next = change(expire(stored.value));
    if (next === stored.value) return next;
    try {
      await backend.writeJson(path, next, stored.etag);
      return next;
    } catch (error) {
      if (!(error instanceof PreconditionFailed)) throw error;
    }
  }
  throw new TooContended(path, 5);
}

export async function createGame(wallet: string): Promise<GameDocument> {
  const createdAt = Date.now();
  const seed = randomInt(2 ** 32);
  const game: GameDocument = {
    id: sortableId(createdAt, randomUUID()),
    rulesVersion: RULES_VERSION,
    seed,
    board: boardFromSeed(seed),
    createdAt,
    status: 'ready',
    startedAt: null,
    endsAt: null,
    finishedAt: null,
    endedBy: null,
    words: [],
    score: 0,
    submissions: 0,
    lastSubmission: null,
  };
  // Preparation is separate from starting. The client keeps the id in the URL
  // before starting, so a lost start response is retried without a fresh clock.
  if (!(await storeBackend().createIfAbsent(gamePath(wallet, game.id), game))) {
    throw new GameError('try_again', 409);
  }
  return game;
}

export const readGame = (wallet: string, id: string) => changeGame(wallet, id, (game) => game);

export function startGame(wallet: string, id: string): Promise<GameDocument> {
  return changeGame(wallet, id, (game) => {
    if (game.status !== 'ready') return game;
    const startedAt = Date.now();
    return { ...game, status: 'playing', startedAt, endsAt: startedAt + ROUND_MS };
  });
}

export async function submitWord(
  wallet: string,
  id: string,
  sequence: unknown,
  path: unknown,
): Promise<GameDocument> {
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1) {
    throw new GameError('invalid_sequence', 400);
  }
  return changeGame(wallet, id, (game) => {
    // Already satisfied, not an error. A replay returns the state as it stands,
    // even when the round has since ended or another submission has landed.
    if (sequence <= game.submissions || game.status === 'finished') return game;
    if (game.status !== 'playing') throw new GameError('not_started', 409);
    if (sequence !== game.submissions + 1) throw new GameError('out_of_sequence', 409);
    if (!Array.isArray(path)) throw new GameError('invalid_path', 400);
    const word = wordForPath(game.board, path);
    if (word === null) throw new GameError('invalid_path', 400);
    const outcome = game.words.includes(word)
      ? 'already_found'
      : pointsForWord(word) > 0 && isWord(word)
        ? 'accepted'
        : 'not_word';
    const points = outcome === 'accepted' ? pointsForWord(word) : 0;
    // Word deduplication, score, and sequence advance in the same atomic write.
    // Even a rejected word consumes its sequence so its retry is unambiguous.
    return {
      ...game,
      submissions: sequence,
      words: outcome === 'accepted' ? [...game.words, word] : game.words,
      score: game.score + points,
      lastSubmission: { sequence, word, points, outcome },
    };
  });
}

export function finishGame(wallet: string, id: string): Promise<GameDocument> {
  return changeGame(wallet, id, (game) => {
    if (game.status === 'finished') return game;
    if (game.status === 'ready') throw new GameError('not_started', 409);
    return { ...game, status: 'finished', finishedAt: Date.now(), endedBy: 'player' };
  });
}

export async function listGames(
  wallet: string,
  cursor?: string,
): Promise<{
  games: GameSummary[];
  cursor?: string;
}> {
  const page = await storeBackend().list<GameDocument>(prefix(wallet), { limit: 20, cursor });
  const games = await Promise.all(
    page.items
      .filter((stored) => stored.rulesVersion === RULES_VERSION)
      .map(async (stored) => {
        // Expired rounds finish on the next read, including after an app was killed.
        const game = expire(stored) === stored ? stored : await readGame(wallet, stored.id);
        return {
          id: game.id,
          status: game.status,
          createdAt: game.createdAt,
          score: game.score,
          wordCount: game.words.length,
        };
      }),
  );
  return { games, cursor: page.cursor };
}
