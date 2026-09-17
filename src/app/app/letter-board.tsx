import { adjacent } from '@/lib/word-hunt';

import styles from './word-hunt.module.css';

export function LetterBoard({
  board,
  path,
  onSelect,
  disabled = false,
}: {
  board: readonly string[];
  path: readonly number[];
  onSelect?: (index: number) => void;
  disabled?: boolean;
}) {
  const last = path.at(-1);
  return (
    <div className={styles.board} role="group" aria-label="Letter board">
      <svg
        className="pointer-events-none absolute inset-0 size-full"
        viewBox="0 0 100 100"
        aria-hidden="true"
      >
        <polyline
          points={path
            .map((index) => `${12.5 + (index % 4) * 25},${12.5 + Math.floor(index / 4) * 25}`)
            .join(' ')}
          fill="none"
          stroke="var(--color-emerald-300)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <div className={styles.letters}>
        {board.map((letter, index) => {
          const selected = path.includes(index);
          const available = selected || last === undefined || adjacent(last, index);
          return (
            <button
              key={index}
              type="button"
              aria-label={`${letter}, row ${Math.floor(index / 4) + 1}, column ${(index % 4) + 1}`}
              aria-pressed={selected}
              disabled={disabled || !onSelect || !available}
              onClick={() => onSelect?.(index)}
              className={`${styles.tile} ${selected ? 'bg-emerald-300 text-neutral-950' : 'bg-neutral-200 text-neutral-950'} ${!available ? 'opacity-45' : ''} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300`}
            >
              {letter === 'QU' ? 'Qu' : letter}
            </button>
          );
        })}
      </div>
    </div>
  );
}
