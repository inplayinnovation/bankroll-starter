'use client';

import { useEffect, useState } from 'react';

import { gameRequest } from '@/lib/client/games';
import type { GamesResponse } from '@/lib/word-hunt';

export function Results({ onOpen }: { onOpen: (id: string) => void }) {
  const [page, setPage] = useState<GamesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    void gameRequest<GamesResponse>('').then(
      (result) => {
        if (active) {
          setPage(result);
          setError(null);
        }
      },
      () => {
        if (active) setError('Could not load results.');
      },
    );
    return () => {
      active = false;
    };
  }, [reload]);

  async function more() {
    if (!page?.cursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      const next = await gameRequest<GamesResponse>(`?cursor=${encodeURIComponent(page.cursor)}`);
      setPage({ games: [...page.games, ...next.games], cursor: next.cursor });
    } catch {
      setError('Could not load more results.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {!page && !error && <p className="text-center text-sm text-neutral-500">Loading…</p>}
      {page?.games.length === 0 && (
        <p className="py-6 text-center text-sm text-neutral-500">No results yet.</p>
      )}
      {page?.games.map((game) => (
        <button
          key={game.id}
          onClick={() => onOpen(game.id)}
          className="flex min-h-16 items-center justify-between gap-3 rounded-xl bg-neutral-900 px-4 py-3 text-left hover:bg-neutral-800"
        >
          <span className="min-w-0">
            <span className="block text-sm">
              {game.status === 'finished'
                ? `${game.wordCount} ${game.wordCount === 1 ? 'word' : 'words'}`
                : 'Resume round'}
            </span>
            <time
              className="text-xs text-neutral-500"
              dateTime={new Date(game.createdAt).toISOString()}
            >
              {new Date(game.createdAt).toLocaleString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </time>
          </span>
          <span className="shrink-0 text-xl font-semibold tabular-nums">
            {game.score}
            <span className="ml-1 text-xs font-normal text-neutral-400">pts</span>
          </span>
        </button>
      ))}
      {error && (
        <p role="status" className="text-center text-sm text-neutral-400">
          {error}{' '}
          {!page && (
            <button
              className="min-h-11 px-2 underline"
              onClick={() => setReload((value) => value + 1)}
            >
              Retry
            </button>
          )}
        </p>
      )}
      {page?.cursor && (
        <button
          className="min-h-11 rounded-lg border border-neutral-800 text-sm"
          disabled={loading}
          onClick={() => void more()}
        >
          {loading ? 'Loading…' : 'More'}
        </button>
      )}
    </div>
  );
}
