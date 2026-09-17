'use client';

import { useState } from 'react';

import { useGame } from '@/lib/client/games';
import type { GameView } from '@/lib/word-hunt';

import { LetterBoard } from './letter-board';
import styles from './word-hunt.module.css';

export function GameScreen({ id, onHome }: { id: string; onHome: () => void }) {
  const { game, remaining, pending, error, submit, finish, retry } = useGame(id);
  const [path, setPath] = useState<number[]>([]);

  if (game?.status === 'finished') return <GameResult game={game} onHome={onHome} />;
  if (!game || game.status === 'ready') {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
        <p role="status" className="text-sm text-neutral-400">
          {error ?? 'Opening round…'}
        </p>
        {error && (
          <button className="btn" disabled={pending} onClick={() => void retry()}>
            Retry
          </button>
        )}
        <button className="min-h-11 px-4 text-sm text-neutral-400" onClick={onHome}>
          Home
        </button>
      </div>
    );
  }

  const word = path.map((index) => game.board[index]).join('');
  const last = game.lastSubmission;
  const feedback =
    last?.outcome === 'accepted'
      ? `${last.word} +${last.points}`
      : last?.outcome === 'already_found'
        ? `${last.word} already found`
        : last
          ? `${last.word} isn't a word`
          : '';

  function select(index: number) {
    setPath((current) => {
      const used = current.indexOf(index);
      // Tap the last tile to undo, or an earlier tile to backtrack to it.
      if (used >= 0) return current.slice(0, used === current.length - 1 ? used : used + 1);
      return [...current, index];
    });
  }

  // Gameplay owns the entire safe-area frame. No tabs, balance, help button,
  // or growing word list competes with the board for height.
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden"
      aria-label="Word Hunt round"
    >
      <div className="flex shrink-0 items-center justify-between gap-4">
        <p
          className="rounded-full bg-neutral-800 px-4 py-2 font-mono text-lg tabular-nums"
          aria-label="Time remaining"
        >
          {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}
        </p>
        <p className="text-4xl font-semibold tabular-nums" aria-label={`${game.score} points`}>
          {game.score}
        </p>
        <button
          className="min-h-11 px-2 text-sm text-neutral-400 hover:text-neutral-100"
          disabled={pending || Boolean(error)}
          onClick={() => void finish()}
        >
          Finish
        </button>
      </div>
      <div className={`${styles.boardSpace} flex-1`}>
        <LetterBoard
          board={game.board}
          path={path}
          onSelect={select}
          disabled={pending || remaining === 0 || Boolean(error)}
        />
      </div>
      <div className="flex h-10 shrink-0 items-center justify-center overflow-hidden px-1">
        <p className="truncate text-2xl font-semibold tracking-widest" aria-label="Selected word">
          {word || '\u00a0'}
        </p>
      </div>
      <div className="flex shrink-0 gap-3">
        <button
          className="min-h-11 rounded-lg border border-neutral-700 px-5 text-sm disabled:opacity-40"
          disabled={!path.length || pending || Boolean(error)}
          onClick={() => setPath([])}
        >
          Clear
        </button>
        <button
          className="btn min-h-11 flex-1"
          disabled={word.length < 3 || pending || remaining === 0 || Boolean(error)}
          onClick={async () => {
            if (await submit(path)) setPath([]);
          }}
        >
          Submit
        </button>
      </div>
      <div
        className="flex h-12 shrink-0 items-center justify-center gap-2 text-center text-xs"
        role="status"
        aria-live="polite"
      >
        {error ? (
          <>
            <span className="text-amber-200">{error}</span>
            <button
              className="min-h-11 shrink-0 px-2 underline"
              disabled={pending}
              onClick={async () => {
                if (await retry()) setPath([]);
              }}
            >
              Retry
            </button>
          </>
        ) : (
          <span className="text-neutral-400">{remaining === 0 ? 'Finishing…' : feedback}</span>
        )}
      </div>
    </div>
  );
}

function GameResult({ game, onHome }: { game: GameView; onHome: () => void }) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-hidden"
      aria-label="Round result"
    >
      <p className="text-sm text-neutral-400">
        {game.endedBy === 'time' ? "Time's up" : 'Round complete'}
      </p>
      <div className="text-center">
        <h1 className="text-8xl font-semibold tabular-nums">{game.score}</h1>
        <p className="mt-2 text-sm text-neutral-400">
          points · {game.wordCount} {game.wordCount === 1 ? 'word' : 'words'}
        </p>
      </div>
      <button className="btn mt-4 min-h-11 w-full max-w-xs" onClick={onHome}>
        Home
      </button>
    </div>
  );
}
