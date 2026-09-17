// Rules shared with the board UI. Scoring and dictionary membership are
// enforced again on the server; this module grants the client no authority.
export const BOARD_SIZE = 4;
export const ROUND_MS = 60_000;
export const RULES_VERSION = 1;

export function adjacent(a: number, b: number): boolean {
  return (
    a !== b &&
    Math.abs(Math.floor(a / BOARD_SIZE) - Math.floor(b / BOARD_SIZE)) <= 1 &&
    Math.abs((a % BOARD_SIZE) - (b % BOARD_SIZE)) <= 1
  );
}

export function wordForPath(board: readonly string[], path: readonly number[]): string | null {
  if (!path.length || path.length > 16 || new Set(path).size !== path.length) return null;
  for (let i = 0; i < path.length; i++) {
    if (!Number.isInteger(path[i]) || path[i] < 0 || path[i] >= board.length) return null;
    if (i > 0 && !adjacent(path[i - 1], path[i])) return null;
  }
  return path.map((index) => board[index]).join('');
}

export function pointsForWord(word: string): number {
  if (word.length < 3) return 0;
  if (word.length <= 4) return 1;
  if (word.length === 5) return 2;
  if (word.length === 6) return 3;
  if (word.length === 7) return 5;
  return 11;
}

export interface Submission {
  sequence: number;
  word: string;
  points: number;
  outcome: 'accepted' | 'not_word' | 'already_found';
}

export interface GameSummary {
  id: string;
  status: 'ready' | 'playing' | 'finished';
  createdAt: number;
  score: number;
  wordCount: number;
}

export interface GameView extends GameSummary {
  rulesVersion: number;
  /** Empty until the server starts the clock. */
  board: string[];
  startedAt: number | null;
  endsAt: number | null;
  finishedAt: number | null;
  endedBy: 'time' | 'player' | null;
  submissions: number;
  lastSubmission: Submission | null;
}

export interface GameResponse {
  game: GameView;
  serverNow: number;
}

export interface GamesResponse {
  games: GameSummary[];
  cursor?: string;
}
