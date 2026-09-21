import { describe, expect, it } from 'vitest';

import {
  shootingGame,
  simulateShot,
  type ShootingChallenge,
  type ShotInput,
} from '../examples/shooting';
import { wordsGame, type WordsChallenge } from '../examples/words';
import { EngineError, type GameContext, type Progress } from '../types';

function context<C>(challenge: C, durationMs: number, submissionGraceMs = 0): GameContext<C> {
  const startedAt = 10_000;
  return {
    challenge,
    startedAt,
    endsAt: startedAt + durationMs,
    closesAt: startedAt + durationMs + submissionGraceMs,
    now: startedAt,
  };
}
function running<S, R>(progress: Progress<S, R>): S {
  expect(progress.status).toBe('running');
  return progress.state;
}
function finished<S, R>(progress: Progress<S, R>): R {
  expect(progress.status).toBe('finished');
  if (progress.status !== 'finished') throw new Error('Expected a finished game');
  return progress.result;
}
function invalidAction(action: () => unknown) {
  expect(action).toThrow(EngineError);
  expect(action).toThrow(expect.objectContaining({ code: 'invalid_action' }));
}

describe('streamed word game example', () => {
  const ctx = context<WordsChallenge>({ board: 'CATRESDOG' }, wordsGame.durationMs);
  const action = (path: number[]) => ({
    type: 'action' as const,
    action: wordsGame.parseAction({ type: 'word', path }),
  });

  it('generates and validates deterministic challenges with the same legal CAT path', () => {
    expect(wordsGame.challenge('same seed')).toEqual(wordsGame.challenge('same seed'));
    for (const seed of ['a', 'b', 'c', 'd']) {
      const challenge = wordsGame.parseChallenge(wordsGame.challenge(seed));
      const current = { ...ctx, challenge };
      const initial = wordsGame.start(current);
      const path = ['C', 'A', 'T'].map((letter) => challenge.board.indexOf(letter));
      expect(wordsGame.step(initial.state, action(path), current).state.score).toBe(1);
    }
    expect(() => wordsGame.parseChallenge({ board: 'AAAAAAAAA' })).toThrow(
      'Unsupported word challenge',
    );
  });

  it('scores distinct paths without mutation and finishes from either a command or its deadline', () => {
    const initial = running(wordsGame.start(ctx));
    const cat = running(wordsGame.step(initial, action([0, 1, 2]), ctx));
    const care = running(wordsGame.step(cat, action([0, 1, 3, 4]), ctx));
    expect(initial).toEqual({ words: [], score: 0 });
    expect(cat).toEqual({ words: ['CAT'], score: 1 });
    expect(care).toEqual({ words: ['CAT', 'CARE'], score: 3 });
    const expected = { score: 3, wordCount: 2 };
    expect(
      finished(wordsGame.step(care, { type: 'action', action: { type: 'finish' } }, ctx)),
    ).toEqual(expected);
    expect(
      finished(wordsGame.step(care, { type: 'deadline' }, { ...ctx, now: ctx.closesAt })),
    ).toEqual(expected);
    const view = wordsGame.view(care, ctx);
    view.words.push('CHANGED');
    expect(care.words).toEqual(['CAT', 'CARE']);
    expect(view).toMatchObject({ board: 'CATRESDOG', score: 3, endsAt: ctx.endsAt });
  });

  it('rejects duplicate words, nonadjacent paths, reused tiles and unknown words', () => {
    const state = running(wordsGame.start(ctx));
    const scored = wordsGame.step(state, action([0, 1, 2]), ctx).state;
    invalidAction(() => wordsGame.step(scored, action([0, 1, 2]), ctx));
    invalidAction(() => wordsGame.step(state, action([0, 8, 1]), ctx));
    invalidAction(() => wordsGame.step(state, action([0, 1, 0]), ctx));
    invalidAction(() => wordsGame.step(state, action([2, 5, 8]), ctx));
    invalidAction(() => wordsGame.parseAction({ type: 'word', path: [0, 1, 9] }));
    invalidAction(() => wordsGame.parseAction({ type: 'word', path: [0, 1.5, 2] }));
  });

  it('enforces play cutoff and returns an actual zero result when no words were played', () => {
    const state = running(wordsGame.start(ctx));
    invalidAction(() => wordsGame.step(state, action([0, 1, 2]), { ...ctx, now: ctx.endsAt }));
    expect(
      wordsGame.step(state, { type: 'deadline' }, { ...ctx, now: ctx.endsAt - 1 }),
    ).toMatchObject({ status: 'running', nextDeadlineAt: ctx.closesAt });
    expect(
      finished(wordsGame.step(state, { type: 'deadline' }, { ...ctx, now: ctx.closesAt })),
    ).toEqual({ score: 0, wordCount: 0 });
    expect(wordsGame.compare({ score: 3, wordCount: 2 }, { score: 1, wordCount: 1 })).toBe('a');
    expect(wordsGame.compare({ score: 0, wordCount: 0 }, { score: 0, wordCount: 0 })).toBe('tie');
  });
});

describe('locally simulated shooting replay example', () => {
  const ctx = context<ShootingChallenge>(
    { distanceCm: 450 },
    shootingGame.durationMs,
    shootingGame.submissionGraceMs,
  );
  const made: ShotInput = { atMs: 0, angleDeg: 45, speedMps: 7.6 };
  const replay = (shots: unknown[]) => ({
    type: 'action' as const,
    action: shootingGame.parseAction({ type: 'replay', shots, score: 999_999 }),
  });

  it('validates deterministic challenges and computes a descending basket from the input trajectory', () => {
    const challenge = shootingGame.challenge('same seed');
    expect(shootingGame.challenge('same seed')).toEqual(challenge);
    expect(shootingGame.parseChallenge(challenge)).toEqual(challenge);
    expect(() => shootingGame.parseChallenge({ distanceCm: 1 })).toThrow(
      'Unsupported shooting challenge',
    );
    expect(simulateShot(ctx.challenge, made)).toMatchObject({ made: true });
    expect(simulateShot(ctx.challenge, { ...made, speedMps: 5 })).toMatchObject({ made: false });
  });

  it('replays multiple shots, discards reported outcomes, and exposes a summary rather than server replay state', () => {
    const state = running(shootingGame.start(ctx));
    const progress = shootingGame.step(
      state,
      replay([
        { ...made, made: false },
        { ...made, atMs: 2_500, speedMps: 5, made: true },
        { ...made, atMs: 5_000 },
      ]),
      { ...ctx, now: ctx.startedAt + 8_000 },
    );
    expect(finished(progress)).toEqual({ score: 4, attempts: 3 });
    expect(state).toEqual({ submitted: false, shots: [] });
    expect(progress.state.shots.map((shot) => shot.made)).toEqual([true, false, true]);
    expect(shootingGame.view(progress.state, ctx)).toEqual({
      score: 4,
      attempts: 3,
      distanceCm: 450,
      submitted: true,
      endsAt: ctx.endsAt,
      closesAt: ctx.closesAt,
    });
    invalidAction(() =>
      shootingGame.step(progress.state, replay([made]), { ...ctx, now: ctx.endsAt }),
    );
  });

  it('permits upload grace without extending shot times, and preserves the final cutoff', () => {
    const state = running(shootingGame.start(ctx));
    expect(
      shootingGame.step(state, { type: 'deadline' }, { ...ctx, now: ctx.endsAt }),
    ).toMatchObject({ status: 'running', nextDeadlineAt: ctx.closesAt });
    expect(
      finished(shootingGame.step(state, replay([made]), { ...ctx, now: ctx.endsAt + 1_000 })),
    ).toEqual({ score: 2, attempts: 1 });
    invalidAction(() =>
      shootingGame.step(state, replay([{ ...made, atMs: shootingGame.durationMs - 1 }]), {
        ...ctx,
        now: ctx.endsAt + 1_000,
      }),
    );
    invalidAction(() => shootingGame.step(state, replay([made]), { ...ctx, now: ctx.closesAt }));
    expect(
      finished(shootingGame.step(state, { type: 'deadline' }, { ...ctx, now: ctx.closesAt })),
    ).toEqual({ score: 0, attempts: 0 });
  });

  it('rejects future samples, reordered/too-fast shots, invalid mechanics and unbounded traces', () => {
    const state = running(shootingGame.start(ctx));
    invalidAction(() =>
      shootingGame.step(state, replay([{ ...made, atMs: 1_000 }]), {
        ...ctx,
        now: ctx.startedAt + 500,
      }),
    );
    for (const shots of [
      [made, { ...made, atMs: 1_999 }],
      [
        { ...made, atMs: 4_000 },
        { ...made, atMs: 2_000 },
      ],
    ])
      invalidAction(() => shootingGame.step(state, replay(shots), { ...ctx, now: ctx.endsAt }));
    for (const shot of [
      { ...made, atMs: -1 },
      { ...made, atMs: 0.5 },
      { ...made, angleDeg: 90 },
      { ...made, speedMps: NaN },
    ])
      invalidAction(() => replay([shot]));
    invalidAction(() => replay(Array.from({ length: 6 }, () => made)));
    expect(finished(shootingGame.step(state, replay([]), ctx))).toEqual({ score: 0, attempts: 0 });
    expect(shootingGame.compare({ score: 0, attempts: 5 }, { score: 2, attempts: 1 })).toBe('b');
  });
});
