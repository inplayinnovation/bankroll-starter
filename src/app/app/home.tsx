'use client';

import { useSearchParams } from 'next/navigation';
import { useRef, useState } from 'react';

import { BankrollBalances } from '@/components/bankroll-balances';
import { TabbedScreen } from '@/components/tabbed-screen';
import { gameRequest } from '@/lib/client/games';
import type { GameResponse } from '@/lib/word-hunt';

import { GameScreen } from './game-screen';
import { HowToPlay } from './how-to-play';
import { Results } from './results';
import styles from './word-hunt.module.css';

function navigate(changes: Record<string, string | null>, replace = false) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  window.history[replace ? 'replaceState' : 'pushState'](
    changes.help ? { wordHuntHelp: true } : null,
    '',
    `${url.pathname}${url.search}${url.hash}`,
  );
}

export function Home() {
  const params = useSearchParams();
  const id = params.get('game');
  const help = params.get('help') === '1';
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const creating = useRef(false);

  async function play() {
    if (creating.current) return;
    creating.current = true;
    setStarting(true);
    setError(null);
    try {
      const { game } = await gameRequest<GameResponse>('', {});
      navigate({ game: game.id, help: null });
    } catch {
      setError('Could not open a round. Try again.');
    } finally {
      creating.current = false;
      setStarting(false);
    }
  }

  // A game deep link wins over the selected tab. This early return also keeps
  // the balance, help, and footer out of gameplay and individual results.
  if (id)
    return (
      <GameScreen
        key={id}
        id={id}
        onHome={() => navigate({ game: null, help: null, tab: null }, true)}
      />
    );

  return (
    <>
      <TabbedScreen
        header={
          <header className="flex items-start justify-between gap-4">
            <button
              className="grid size-11 shrink-0 place-items-center rounded-full border border-neutral-700 text-lg text-neutral-300 hover:bg-neutral-800"
              aria-label="How to play"
              onClick={() => navigate({ help: '1' })}
            >
              ?
            </button>
            <BankrollBalances />
          </header>
        }
        tabs={[
          {
            id: 'play',
            label: 'Play',
            content: (
              <div
                className={`${styles.home} flex h-full min-h-0 flex-col items-center justify-center gap-6 overflow-hidden`}
              >
                <div className={`${styles.wordMark} grid grid-cols-2 gap-1.5`} aria-hidden="true">
                  {'WORD'.split('').map((letter) => (
                    <span
                      key={letter}
                      className="grid size-12 place-items-center rounded-lg bg-neutral-200 text-2xl font-semibold text-neutral-950"
                    >
                      {letter}
                    </span>
                  ))}
                </div>
                <h1 className="text-3xl font-semibold tracking-tight">Word Hunt</h1>
                <div className="w-full max-w-xs">
                  {/* Options belong on Home; instructions live behind the ?. */}
                  <div className="mb-3 flex items-center justify-between rounded-xl border border-neutral-700 bg-neutral-900 px-4 py-3 text-sm">
                    <span>
                      Classic <span className="ml-2 text-neutral-400">60s</span>
                    </span>
                    <span className="text-neutral-400">Free</span>
                  </div>
                  <button
                    className="btn min-h-12 w-full"
                    disabled={starting}
                    onClick={() => void play()}
                  >
                    {starting ? 'Opening…' : 'Play'}
                  </button>
                  {error && (
                    <p role="status" className="mt-3 text-center text-xs text-amber-200">
                      {error}
                    </p>
                  )}
                </div>
              </div>
            ),
          },
          {
            id: 'results',
            label: 'Results',
            scroll: true,
            content: <Results onOpen={(gameId) => navigate({ game: gameId })} />,
          },
        ]}
      />
      {help && (
        <HowToPlay
          onClose={() => {
            if (window.history.state?.wordHuntHelp) window.history.back();
            else navigate({ help: null }, true);
          }}
        />
      )}
    </>
  );
}
