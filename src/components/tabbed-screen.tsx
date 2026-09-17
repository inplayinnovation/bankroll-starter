'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';

type Tab = {
  id: string;
  label: string;
  /** Optional custom icon; play and results have built-in defaults. */
  icon?: ReactNode;
  content: ReactNode;
  scroll?: boolean;
};

const defaultIconPaths: Record<string, ReactNode> = {
  play: <path d="m8 4 12 8-12 8V4Z" />,
  results: (
    <>
      <path d="M8 3h8v7a4 4 0 0 1-8 0V3Z" />
      <path d="M8 5H5v2a4 4 0 0 0 4 4m7-6h3v2a4 4 0 0 1-4 4M12 14v6m-4 1h8" />
    </>
  ),
};

/** The first tab is the default. Render gameplay and individual results separately. */
export function TabbedScreen({
  header,
  tabs,
}: {
  header?: ReactNode;
  tabs: readonly [Tab, ...Tab[]];
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = tabs.find((tab) => tab.id === searchParams.get('tab')) ?? tabs[0];

  function tabHref(id: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (id === tabs[0].id) params.delete('tab');
    else params.set('tab', id);
    const query = params.toString();
    return query ? `${pathname}?${query}` : pathname;
  }

  // The app shell supplies a viewport-sized frame and safe-area padding once.
  // Only the content can scroll. The footer stays outside it, in its own row,
  // so long history lists cannot move the tabs or disappear underneath them.
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden">
      {header && <div className="shrink-0">{header}</div>}
      <section
        key={active.id}
        aria-label={active.label}
        tabIndex={active.scroll ? 0 : undefined}
        className={`min-h-0 min-w-0 flex-1 overflow-x-hidden focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 ${
          active.scroll ? 'overflow-y-auto overscroll-y-contain' : 'overflow-hidden'
        }`}
      >
        {active.content}
      </section>
      <nav
        aria-label="App navigation"
        className="flex shrink-0 gap-2 border-t border-neutral-800 pt-1"
      >
        {tabs.map((tab) => {
          const href = tabHref(tab.id);
          return (
            <a
              key={tab.id}
              href={href}
              aria-current={active.id === tab.id ? 'page' : undefined}
              className="flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-3 py-1 text-center text-[11px] leading-3.5 font-medium text-neutral-400 hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-100 aria-[current=page]:text-neutral-100"
              onClick={(event) => {
                if (
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                event.preventDefault();
                // Next observes native history updates. Replacing keeps tab
                // switches out of Back history; unrelated query params survive.
                window.history.replaceState(null, '', href + window.location.hash);
              }}
            >
              <span aria-hidden="true" className="flex size-5 items-center justify-center">
                {tab.icon ?? (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="size-5"
                  >
                    {defaultIconPaths[tab.id]}
                  </svg>
                )}
              </span>
              <span>{tab.label}</span>
            </a>
          );
        })}
      </nav>
    </div>
  );
}
