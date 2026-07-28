'use client';

// Developer tools, shown only in development and only inside the Bankroll app.
//
// Outside the host there's nothing to overlay — the app can't run, so the page
// is the QR code instead. Inside it, the app works and what a developer wants
// is the state behind it: which treasury is signing, where data is going, which
// RPC. It is the only place that reports configuration, and it reports it where
// the app actually runs.
//
// Next's own indicator sits bottom-left by default, so this takes bottom-right.
import { useEffect, useState } from 'react';

const COPIED_FEEDBACK_MS = 1200;

// Two dev badges stacked in a phone-sized viewport is clutter, so Next's is
// hidden until asked for. It can't be turned off in next.config without losing
// it for good, so it's hidden by CSS instead — which keeps it one tap away.
//
// This reaches into Next's overlay, which is internal and may be renamed. If
// the shape ever changes the failure is Next's badge staying visible, not
// anything breaking.
const NEXT_PORTAL = 'nextjs-portal';
// The badge ROOT, not the button inside it: hiding only the button leaves its
// container drawing an empty sliver at the edge of the screen. Still narrower
// than the portal, so the error overlay is untouched.
const NEXT_INDICATOR = '[data-next-badge-root]';
const HIDE_STYLE_ID = 'bankroll-hides-next-indicator';

function useNextIndicatorHidden(hidden: boolean) {
  useEffect(() => {
    const apply = () => {
      const root = document.querySelector(NEXT_PORTAL)?.shadowRoot;
      if (!root) return false;
      const existing = root.getElementById(HIDE_STYLE_ID);
      if (!hidden) {
        existing?.remove();
        return true;
      }
      if (existing) return true;
      const style = document.createElement('style');
      style.id = HIDE_STYLE_ID;
      style.textContent = `${NEXT_INDICATOR}{display:none!important}`;
      root.append(style);
      return true;
    };

    // The overlay mounts on its own schedule, so watch for it rather than
    // assuming it's there on first render.
    if (apply()) return;
    const observer = new MutationObserver(() => {
      if (apply()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [hidden]);
}

export interface DevRow {
  label: string;
  /** The full value — what gets copied. */
  value: string;
  ok: boolean;
  /** Shown instead of `value` when the full thing is too long to read here. */
  display?: string;
  /** Offer a copy button; the full `value` is what lands on the clipboard. */
  copy?: boolean;
}

// Addresses are shown short because the panel is narrow on a phone, which is
// only safe because the copy button hands over the full value — a truncated
// address you can't copy is useless.
const TRUNCATE_EDGE = 4;
const truncate = (value: string) =>
  value.length > TRUNCATE_EDGE * 2 + 1
    ? `${value.slice(0, TRUNCATE_EDGE)}…${value.slice(-TRUNCATE_EDGE)}`
    : value;

export function DevTools({ rows }: { rows: DevRow[] }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [showNext, setShowNext] = useState(false);

  useNextIndicatorHidden(!showNext);

  const copyValue = async (row: DevRow) => {
    await navigator.clipboard.writeText(row.value);
    setCopied(row.label);
    setTimeout(() => setCopied(null), COPIED_FEEDBACK_MS);
  };

  return (
    <div className="fixed right-3 bottom-3 z-50 flex flex-col items-end gap-2">
      {open && (
        <dl className="w-[min(21rem,calc(100vw-1.5rem))] overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950 shadow-xl">
          {rows.map((row) => (
            <div
              key={row.label}
              className="flex items-center gap-3 border-b border-neutral-900 pr-1 pl-3 last:border-b-0"
            >
              <dt className="w-16 shrink-0 py-3 text-xs text-neutral-500">{row.label}</dt>
              <dd
                className={`min-w-0 flex-1 truncate py-3 font-mono text-xs ${
                  row.ok ? 'text-neutral-300' : 'text-amber-400'
                }`}
              >
                {row.display ?? (row.copy ? truncate(row.value) : row.value)}
              </dd>
              {row.copy && (
                <button
                  aria-label={`Copy ${row.label}`}
                  className="flex h-11 w-14 shrink-0 items-center justify-center text-xs text-neutral-500 active:text-neutral-200"
                  onClick={() => copyValue(row)}
                  type="button"
                >
                  {copied === row.label ? 'copied' : 'copy'}
                </button>
              )}
            </div>
          ))}

          {/* A footer, not a row — it's a control rather than a fact. */}
          <button
            className="flex h-11 w-full items-center gap-2 border-t border-neutral-800 px-3 text-left text-xs text-neutral-500 active:text-neutral-200"
            onClick={() => setShowNext((shown) => !shown)}
            type="button"
          >
            <span className="flex-1">Next dev tools</span>
            <span>{showNext ? 'hide' : 'show'}</span>
          </button>
        </dl>
      )}

      <button
        aria-expanded={open}
        aria-label="Bankroll developer tools"
        className="size-11 overflow-hidden rounded-full shadow-lg shadow-black/50 ring-1 ring-white/15 transition hover:ring-white/25 active:scale-95"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        type="button"
      >
        <BankrollMark />
      </button>
    </div>
  );
}

// The Bankroll icon, from Bankroll_Icon_FullColor_Solid.svg. Inlined rather
// than served as a file so the badge costs no request and can't 404 in an app
// that has replaced everything in public/.
const BANKROLL_GREEN = '#97F04A';
const BANKROLL_BLACK = '#131416';

function BankrollMark() {
  return (
    <svg aria-hidden="true" className="size-full" fill="none" viewBox="0 0 1024 1024">
      <rect fill={BANKROLL_GREEN} height="1024" width="1024" />
      <path
        d="M206.844 382.294C201.407 382.294 197 377.887 197 372.45L197 206.843C197 201.407 201.407 197 206.844 197L738.213 197C787.249 197 827 238.479 827 289.647C827 340.815 787.249 382.294 738.213 382.294H206.844Z"
        fill={BANKROLL_BLACK}
      />
      <path
        clipRule="evenodd"
        d="M197 817.156C197 822.593 201.407 827 206.844 827H694.978C767.89 827 826.998 773.479 826.998 707.457L827 524.076C827.001 458.053 767.894 404.531 694.982 404.53H206.844C201.407 404.53 197 408.937 197 414.374L197 817.156ZM526.616 621.324C522.992 621.324 520.054 624.262 520.054 627.886V725.938C520.054 729.562 522.992 732.5 526.616 732.5H669.5C687.622 732.5 702.313 717.855 702.313 699.733C702.313 688.694 702.313 673.937 702.313 654.208C702.313 636.087 687.622 621.324 669.5 621.324H526.616Z"
        fill={BANKROLL_BLACK}
        fillRule="evenodd"
      />
    </svg>
  );
}
