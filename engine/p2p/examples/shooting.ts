import { defineGame, EngineError } from '../game';

export type ShootingChallenge = { distanceCm: number };
export type ShotInput = { atMs: number; angleDeg: number; speedMps: number };
export type ShootingAction = { type: 'replay'; shots: ShotInput[] };
export type ScoredShot = ShotInput & { made: boolean };
export type ShootingState = { submitted: boolean; shots: ScoredShot[] };
export type ShootingResult = { score: number; attempts: number };
export type ShootingView = ShootingResult & {
  distanceCm: number;
  submitted: boolean;
  endsAt: number;
  closesAt: number;
};

const invalid = (message: string): never => {
  throw new EngineError('invalid_action', message);
};
const result = (state: Readonly<ShootingState>): ShootingResult => ({
  score: state.shots.filter((shot) => shot.made).length * 2,
  attempts: state.shots.length,
});

/** Shared deterministic mechanics for local animation and server replay validation.
 * A legal replay does not establish that a human played it; this is a mechanics example.
 */
export function simulateShot(challenge: Readonly<ShootingChallenge>, shot: Readonly<ShotInput>) {
  const angle = (shot.angleDeg * Math.PI) / 180;
  const horizontalSpeed = shot.speedMps * Math.cos(angle);
  const verticalSpeed = shot.speedMps * Math.sin(angle);
  const flightSeconds = challenge.distanceCm / 100 / horizontalSpeed;
  const heightAtHoop = 2 + verticalSpeed * flightSeconds - (9.81 * flightSeconds ** 2) / 2;
  const descending = verticalSpeed - 9.81 * flightSeconds < 0;
  return {
    flightMs: flightSeconds * 1_000,
    made: descending && Math.abs(heightAtHoop - 3.05) <= 0.12,
  };
}

export const shootingGame = defineGame<
  ShootingChallenge,
  ShootingState,
  ShootingAction,
  ShootingResult,
  ShootingView
>({
  id: 'shooting',
  version: 1,
  durationMs: 15_000,
  submissionGraceMs: 3_000,

  challenge(seed) {
    let hash = 0;
    for (const character of seed) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
    return { distanceCm: 430 + (hash % 5) * 10 };
  },
  parseChallenge(value) {
    const distanceCm = (value as Partial<ShootingChallenge> | null)?.distanceCm;
    if (
      typeof distanceCm !== 'number' ||
      !Number.isInteger(distanceCm) ||
      distanceCm < 430 ||
      distanceCm > 470 ||
      distanceCm % 10 !== 0
    )
      throw new Error('Unsupported shooting challenge');
    return { distanceCm };
  },
  parseAction(value) {
    if (typeof value !== 'object' || value === null) return invalid('Expected a replay');
    const input = value as Record<string, unknown>;
    if (input.type !== 'replay' || !Array.isArray(input.shots) || input.shots.length > 5)
      return invalid('A replay contains at most five shots');
    const shots = input.shots.map((value: unknown): ShotInput => {
      if (typeof value !== 'object' || value === null) return invalid('Invalid shot');
      const { atMs, angleDeg, speedMps } = value as Record<string, unknown>;
      if (
        typeof atMs !== 'number' ||
        !Number.isSafeInteger(atMs) ||
        atMs < 0 ||
        typeof angleDeg !== 'number' ||
        !Number.isFinite(angleDeg) ||
        angleDeg < 35 ||
        angleDeg > 75 ||
        typeof speedMps !== 'number' ||
        !Number.isFinite(speedMps) ||
        speedMps < 4 ||
        speedMps > 12
      )
        return invalid('Shot time, angle or speed is out of bounds');
      // Only inputs are accepted. Any claimed score or made flag is discarded.
      return { atMs, angleDeg, speedMps };
    });
    return { type: 'replay', shots };
  },
  start(context) {
    return {
      status: 'running',
      state: { submitted: false, shots: [] },
      nextDeadlineAt: context.closesAt,
    };
  },
  step(state, event, context) {
    if (event.type === 'deadline') {
      if (!state.submitted && context.now < context.closesAt)
        return { status: 'running', state, nextDeadlineAt: context.closesAt };
      return { status: 'finished', state, result: result(state) };
    }
    if (state.submitted) return invalid('The replay was already submitted');
    if (context.now < context.startedAt || context.now >= context.closesAt)
      return invalid('The submission window is closed');

    let previousAt = -2_000;
    const shots = event.action.shots.map((shot): ScoredShot => {
      if (shot.atMs < previousAt + 2_000)
        return invalid('Shots must be ordered and at least two seconds apart');
      previousAt = shot.atMs;
      const simulated = simulateShot(context.challenge, shot);
      const completedAt = context.startedAt + shot.atMs + simulated.flightMs;
      if (completedAt > context.endsAt || completedAt > context.now)
        return invalid('A shot must complete during play and before submission');
      return { ...shot, made: simulated.made };
    });
    const finished: ShootingState = { submitted: true, shots };
    return { status: 'finished', state: finished, result: result(finished) };
  },
  view(state, context) {
    return {
      ...result(state),
      distanceCm: context.challenge.distanceCm,
      submitted: state.submitted,
      endsAt: context.endsAt,
      closesAt: context.closesAt,
    };
  },
  compare(a, b) {
    return a.score === b.score ? 'tie' : a.score > b.score ? 'a' : 'b';
  },
});
