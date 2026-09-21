import { defineGame, EngineError } from '../game';

export type WordsChallenge = { board: string };
export type WordsState = { words: string[]; score: number };
export type WordsAction = { type: 'word'; path: number[] } | { type: 'finish' };
export type WordsResult = { score: number; wordCount: number };
export type WordsView = WordsState & { board: string; endsAt: number };

// A deliberately small puzzle/dictionary makes the example easy to understand.
// Rotation preserves every valid path while demonstrating seeded challenges.
const boards = ['CATRESDOG'];
for (let turn = 1; turn < 4; turn++) {
  const previous = boards[turn - 1];
  boards.push([6, 3, 0, 7, 4, 1, 8, 5, 2].map((index) => previous[index]).join(''));
}
const dictionary = new Set([
  'ARE',
  'ART',
  'CAR',
  'CARD',
  'CARE',
  'CARS',
  'CART',
  'CASE',
  'CAT',
  'CATS',
  'DOG',
  'EAR',
  'EARS',
  'EAT',
  'EATS',
  'ORE',
  'RAT',
  'RATE',
  'RATS',
  'RED',
  'REST',
  'ROD',
  'RODE',
  'SEA',
  'SEAT',
  'SET',
  'STAR',
  'TAR',
  'TEA',
  'TEAR',
]);
const invalid = (message: string): never => {
  throw new EngineError('invalid_action', message);
};

export const wordsGame = defineGame<
  WordsChallenge,
  WordsState,
  WordsAction,
  WordsResult,
  WordsView
>({
  id: 'words',
  version: 1,
  durationMs: 120_000,
  submissionGraceMs: 0,

  challenge(seed) {
    let hash = 0;
    for (const character of seed) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
    return { board: boards[hash % boards.length] };
  },
  parseChallenge(value) {
    const board = (value as Partial<WordsChallenge> | null)?.board;
    if (typeof board !== 'string' || !boards.includes(board))
      throw new Error('Unsupported word challenge');
    return { board };
  },
  parseAction(value) {
    if (typeof value !== 'object' || value === null) return invalid('Expected a word action');
    const input = value as Record<string, unknown>;
    if (input.type === 'finish') return { type: 'finish' };
    if (
      input.type !== 'word' ||
      !Array.isArray(input.path) ||
      input.path.length < 3 ||
      input.path.length > 9
    )
      return invalid('A word needs a path of three to nine tiles');
    const path = input.path.map((index: unknown) => {
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 8)
        return invalid('Tile index is out of bounds');
      return index;
    });
    return { type: 'word', path };
  },
  start(context) {
    return { status: 'running', state: { words: [], score: 0 }, nextDeadlineAt: context.closesAt };
  },
  step(state, event, context) {
    if (event.type === 'deadline') {
      if (context.now < context.closesAt)
        return { status: 'running', state, nextDeadlineAt: context.closesAt };
      return {
        status: 'finished',
        state,
        result: { score: state.score, wordCount: state.words.length },
      };
    }
    if (context.now < context.startedAt || context.now >= context.endsAt)
      return invalid('The play window is closed');
    if (event.action.type === 'finish')
      return {
        status: 'finished',
        state,
        result: { score: state.score, wordCount: state.words.length },
      };

    const { path } = event.action;
    if (new Set(path).size !== path.length) return invalid('A tile cannot be reused in one word');
    for (let i = 1; i < path.length; i++) {
      const rowDistance = Math.abs(Math.floor(path[i] / 3) - Math.floor(path[i - 1] / 3));
      const columnDistance = Math.abs((path[i] % 3) - (path[i - 1] % 3));
      if (Math.max(rowDistance, columnDistance) !== 1) return invalid('Tiles must touch');
    }
    const word = path.map((index) => context.challenge.board[index]).join('');
    if (!dictionary.has(word)) return invalid('Word is not in the example dictionary');
    if (state.words.includes(word)) return invalid('That word was already scored');
    return {
      status: 'running',
      state: { words: [...state.words, word], score: state.score + word.length - 2 },
      nextDeadlineAt: context.closesAt,
    };
  },
  view(state, context) {
    return {
      board: context.challenge.board,
      words: [...state.words],
      score: state.score,
      endsAt: context.endsAt,
    };
  },
  compare(a, b) {
    return a.score === b.score ? 'tie' : a.score > b.score ? 'a' : 'b';
  },
});
