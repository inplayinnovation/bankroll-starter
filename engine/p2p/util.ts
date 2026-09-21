import { createHash } from 'node:crypto';

import { HSUSD_MINT } from '@joinbankroll/sdk/server';

import type { GameDefinition, Policy, TreasuryTerms } from './types';
import { EngineError } from './types';
import type { Terms } from './model';

export const DEFAULT_POLICY: Readonly<Policy> = {
  entryCents: 100,
  creatorFeeBps: 1_000,
  startWindowMs: 5 * 60_000,
  queueWindowMs: 24 * 60 * 60_000,
};
export const MAX_WINDOW_MS = 30 * 24 * 60 * 60_000;
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Canonical JSON is also the boundary against non-durable game state/inputs. */
export function canonical(value: unknown): string {
  const seen = new Set<object>();
  function visit(input: unknown): unknown {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (typeof input !== 'object' || seen.has(input)) throw new EngineError('invalid_json');
    const proto = Object.getPrototypeOf(input);
    if (!Array.isArray(input) && proto !== Object.prototype && proto !== null)
      throw new EngineError('invalid_json');
    seen.add(input);
    const result = Array.isArray(input)
      ? input.map(visit)
      : Object.fromEntries(
          Object.keys(input)
            .sort()
            .map((key) => [key, visit((input as Record<string, unknown>)[key])]),
        );
    seen.delete(input);
    return result;
  }
  return JSON.stringify(visit(value));
}

export const copy = <T>(value: T): T => JSON.parse(canonical(value)) as T;
export const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
export function identifier(value: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new EngineError('invalid_argument');
  return value;
}
export function windowMs(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_WINDOW_MS;
}
export function validateGame<C, S, A, R, V>(game: GameDefinition<C, S, A, R, V>) {
  if (
    !/^[a-zA-Z0-9_-]{1,64}$/.test(game.id) ||
    !Number.isSafeInteger(game.version) ||
    game.version < 1 ||
    !windowMs(game.durationMs) ||
    !Number.isSafeInteger(game.submissionGraceMs ?? 0) ||
    (game.submissionGraceMs ?? 0) < 0 ||
    game.durationMs + (game.submissionGraceMs ?? 0) > MAX_WINDOW_MS
  )
    throw new EngineError('invalid_game_configuration');
}

export function termsFor(
  gameId: string,
  version: number,
  durationMs: number,
  graceMs: number,
  offerId: string,
  offer: Partial<Policy>,
  treasury: TreasuryTerms,
): Terms {
  const policy = { ...DEFAULT_POLICY, ...offer };
  const fee = (policy.entryCents * 2 * policy.creatorFeeBps) / 10_000;
  const prize = policy.entryCents * 2 - fee;
  if (
    !treasury.payee ||
    !treasury.creatorWallet ||
    treasury.mint !== HSUSD_MINT ||
    !Number.isSafeInteger(policy.entryCents) ||
    !Number.isSafeInteger(policy.entryCents * 2) ||
    policy.entryCents <= 0 ||
    !Number.isSafeInteger(policy.creatorFeeBps) ||
    policy.creatorFeeBps < 0 ||
    policy.creatorFeeBps >= 10_000 ||
    !Number.isSafeInteger(fee) ||
    !Number.isSafeInteger(prize) ||
    prize <= 0 ||
    !windowMs(policy.startWindowMs) ||
    !windowMs(policy.queueWindowMs)
  )
    throw new EngineError('invalid_offer');
  const value = { ...treasury, ...policy, offerId, prizeCents: prize, creatorFeeCents: fee };
  return {
    ...value,
    queue: `p2p:${hash(canonical({ gameId, version, durationMs, graceMs, ...value })).slice(0, 32)}`,
  };
}
