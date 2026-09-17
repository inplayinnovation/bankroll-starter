'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { bankrollFetch } from '@/lib/client/bankroll';
import { ROUND_MS, type GameResponse } from '@/lib/word-hunt';

const messages: Record<string, string> = {
  unauthorized: 'Your session expired. Reopen the app in Bankroll.',
  game_not_found: 'Round not found.',
  invalid_path: 'Choose neighboring letters without reusing a tile.',
  out_of_sequence: 'The round changed. Reload to continue.',
  try_again: 'The round is busy. Try again.',
};

export async function gameRequest<T>(path: string, body?: object): Promise<T> {
  const response = await bankrollFetch(`/api/games${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(messages[result.error] ?? 'Could not save the round. Try again.');
  return result as T;
}

type Command =
  | { kind: 'load' }
  | { kind: 'finish' }
  | {
      kind: 'words';
      sequence: number;
      path: number[];
    };
type Snapshot = GameResponse & { receivedAt: number };

export function useGame(id: string) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(ROUND_MS / 1000);
  const active = useRef(false);
  const inFlight = useRef(false);
  const retryCommand = useRef<Command | null>(null);

  const run = useCallback(
    async (command: Command): Promise<boolean> => {
      if (inFlight.current) return false;
      inFlight.current = true;
      retryCommand.current = command;
      try {
        const path = `/${encodeURIComponent(id)}`;
        let result: GameResponse;
        if (command.kind === 'load') {
          result = await gameRequest<GameResponse>(path);
          if (!active.current) return false;
          if (result.game.status === 'ready') {
            result = await gameRequest<GameResponse>(`${path}/start`, {});
          }
        } else {
          result = await gameRequest<GameResponse>(`${path}/${command.kind}`, command);
        }
        if (active.current) {
          setSnapshot({ ...result, receivedAt: performance.now() });
          setRemaining(
            Math.max(
              0,
              Math.ceil(((result.game.endsAt ?? result.serverNow) - result.serverNow) / 1000),
            ),
          );
          setError(null);
          retryCommand.current = null;
        }
        return true;
      } catch (cause) {
        if (active.current) {
          setError(cause instanceof Error ? cause.message : 'Connection lost. Try again.');
        }
        return false;
      } finally {
        inFlight.current = false;
        if (active.current) setPending(false);
      }
    },
    [id],
  );

  useEffect(() => {
    active.current = true;
    // Strict Mode can discard an effect immediately. Don't start a round for
    // that discarded mount; state updates follow the asynchronous response.
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void run({ kind: 'load' });
    });
    const refresh = () => {
      if (document.visibilityState !== 'hidden') {
        void run(retryCommand.current ?? { kind: 'load' });
      }
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      cancelled = true;
      active.current = false;
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [run]);

  useEffect(() => {
    if (!snapshot || snapshot.game.status !== 'playing') return;
    const interval = setInterval(() => {
      // This clock is only a display. Device clock changes cannot extend play;
      // the server checks its own time on every submission and read.
      const now = snapshot.serverNow + performance.now() - snapshot.receivedAt;
      const seconds = Math.max(0, Math.ceil(((snapshot.game.endsAt ?? now) - now) / 1000));
      setRemaining(seconds);
      if (seconds === 0 && !retryCommand.current) void run({ kind: 'load' });
    }, 200);
    return () => clearInterval(interval);
  }, [snapshot, run]);

  function act(command: Command) {
    if (inFlight.current) return Promise.resolve(false);
    setPending(true);
    setError(null);
    return run(command);
  }

  return {
    game: snapshot?.game ?? null,
    pending,
    error,
    remaining,
    submit: (path: number[]) =>
      act({ kind: 'words', sequence: (snapshot?.game.submissions ?? 0) + 1, path }),
    finish: () => act({ kind: 'finish' }),
    // Retain the exact sequence and path after a lost response. A new sequence
    // would turn a retry into another attempt.
    retry: () => act(retryCommand.current ?? { kind: 'load' }),
  };
}
