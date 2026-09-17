import { describe, expect, it } from 'vitest';

import { pointsForWord, wordForPath } from '@/lib/word-hunt';
import { boardFromSeed } from '@/lib/word-hunt-board';
import { isWord } from '@/lib/word-hunt-dictionary';

const board = ['C', 'A', 'T', 'S', 'D', 'O', 'G', 'E', 'QU', 'I', 'Z', 'R', 'B', 'A', 'L', 'L'];

describe('Word Hunt rules', () => {
  it('deals the same complete board for the same seed', () => {
    const first = boardFromSeed(42);
    expect(first).toEqual(boardFromSeed(42));
    // A rules-version fixture catches accidental changes to the deal itself.
    expect(first).toEqual([
      'I',
      'O',
      'S',
      'R',
      'P',
      'B',
      'Y',
      'S',
      'W',
      'O',
      'L',
      'N',
      'E',
      'E',
      'G',
      'E',
    ]);
    expect(first).not.toEqual(boardFromSeed(43));
    expect(first).toHaveLength(16);
    expect(first.every((letter) => /^[A-Z]$|^QU$/.test(letter))).toBe(true);
  });

  it('accepts horizontal, vertical, and diagonal neighbors', () => {
    expect(wordForPath(board, [0, 1, 2])).toBe('CAT');
    expect(wordForPath(board, [0, 5, 2])).toBe('COT');
    expect(wordForPath(board, [1, 5])).toBe('AO');
  });

  it.each([[], [0, 1, 0], [3, 4], [0, 10], [16], [-1], [0.5], [NaN], [Infinity]])(
    'rejects invalid path %j',
    (...path) => {
      expect(wordForPath(board, path)).toBeNull();
    },
  );

  it('counts Qu as two letters on one tile', () => {
    const word = wordForPath(board, [8, 9, 10]);
    expect(word).toBe('QUIZ');
    expect(isWord(word!)).toBe(true);
    expect(pointsForWord(word!)).toBe(1);
  });

  it('scores length only, with a three-letter minimum', () => {
    expect(
      ['AT', 'CAT', 'CATS', 'STACK', 'STACKS', 'STACKED', 'STACKING'].map(pointsForWord),
    ).toEqual([0, 1, 1, 2, 3, 5, 11]);
    expect(isWord('CAT')).toBe(true);
    expect(isWord('XYZZQ')).toBe(false);
  });
});
