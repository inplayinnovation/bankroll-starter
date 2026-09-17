'use client';

import { useEffect, useRef } from 'react';

import { LetterBoard } from './letter-board';
import styles from './word-hunt.module.css';

const EXAMPLE = ['W', 'O', 'A', 'T', 'S', 'D', 'R', 'E', 'N', 'I', 'L', 'S', 'C', 'A', 'T', 'H'];

export function HowToPlay({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      aria-labelledby="how-to-title"
      className="m-auto max-h-[80dvh] w-[calc(100%-2.5rem)] max-w-sm overflow-y-auto rounded-2xl border border-neutral-700 bg-neutral-900 p-5 text-neutral-100 backdrop:bg-black/75"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="how-to-title" className="font-semibold">
          How to play
        </h2>
        <button
          className="grid size-11 place-items-center rounded-full text-xl hover:bg-neutral-800"
          aria-label="Close instructions"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div
        className={`${styles.boardSpace} mx-auto mt-3 h-48 w-48`}
        aria-label="W to O to R to D, including a diagonal"
      >
        <LetterBoard board={EXAMPLE} path={[0, 1, 6, 5]} />
      </div>
      <p className="mt-3 text-center text-xl font-semibold tracking-widest">
        WORD <span className="text-emerald-300">+1</span>
      </p>
      <p className="mt-3 text-center text-sm text-neutral-300">
        Tap neighboring letters, then Submit.
      </p>
      <p className="mt-1 text-center text-xs text-neutral-400">
        3+ letters · diagonals count · use each tile once
      </p>
      <div
        className="mt-5 grid grid-cols-5 gap-1 text-center text-xs"
        aria-label="Points by word length"
      >
        {[
          ['3–4', 1],
          [5, 2],
          [6, 3],
          [7, 5],
          ['8+', 11],
        ].map(([length, points]) => (
          <div key={length} className="rounded-lg bg-neutral-800 px-1 py-2">
            <span className="text-neutral-400">{length}</span>
            <span className="mt-1 block font-semibold">+{points}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-center text-xs text-neutral-400">
        Each word scores once. Qu counts as two letters.
      </p>
    </dialog>
  );
}
