// Version 1: sixteen letter dice, rolled and shuffled by a seeded generator.
// Keep this deterministic: the same seed and rules version deal the same board.
const DICE = [
  'AAEEGN',
  'ABBJOO',
  'ACHOPS',
  'AFFKPS',
  'AOOTTW',
  'CIMOTU',
  'DEILRX',
  'DELRVY',
  'DISTTY',
  'EEGHNW',
  'EEINSU',
  'EHRTVW',
  'EIOSST',
  'ELRTTY',
  'HIMNQU',
  'HLNNRZ',
];

export function boardFromSeed(seed: number): string[] {
  // Mulberry32. Randomness deals the board once; it never changes scoring.
  let state = seed >>> 0;
  function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 2 ** 32;
  }
  const board = DICE.map((die) => die[Math.floor(random() * die.length)]);
  for (let i = board.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [board[i], board[j]] = [board[j], board[i]];
  }
  return board.map((letter) => (letter === 'Q' ? 'QU' : letter));
}
