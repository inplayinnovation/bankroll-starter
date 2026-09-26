'use client';

// The entry gates — everything that must be true before the app's surface can
// render. Every screen in this app sits inside it; branches build their surface
// in home.tsx and leave this file alone.
//
// The order matters:
//   1. hydration — the host bridge only exists in the browser, so decide
//      nothing until the status has actually been looked at
//   2. configuration — an unconfigured app is being looked at by its developer
//   3. host status — outside Bankroll, or a Bankroll too old for this app
import { useBankrollChecked, useBankrollStatus } from '@/lib/client/bankroll';

export function Gate({ ready, children }: { ready: boolean; children: React.ReactNode }) {
  const status = useBankrollStatus();

  // A server render always reads 'unavailable'. Deciding anything on that
  // would flash "open this in Bankroll" at a phone that is already inside
  // Bankroll, until hydration corrects it — so wait.
  const checked = useBankrollChecked();
  if (!checked) return <Loading />;

  // Unconfigured app: whoever is looking at this is the developer, so say so.
  if (!ready) {
    return (
      <Screen title="Bankroll Starter">
        <p>This app isn&apos;t finished setting up yet, so it can&apos;t take or send money.</p>
        <p className="text-sm text-neutral-500">
          Ask your coding agent to set it up — it&apos;ll find what it needs in{' '}
          <code>AGENTS.md</code>.
        </p>
      </Screen>
    );
  }

  if (status !== 'ready') {
    return (
      <Screen title={status === 'update_required' ? 'Update Bankroll' : 'Open this in Bankroll'}>
        <p>
          {status === 'update_required'
            ? 'This app needs a newer version of the Bankroll app than the one you have.'
            : 'This app moves real money, so it runs inside the Bankroll app where your identity lives.'}
        </p>
        <a className="btn" href="https://joinbankroll.com">
          Get Bankroll
        </a>
      </Screen>
    );
  }

  return children;
}

export function Loading() {
  return <p className="text-neutral-400">Loading…</p>;
}

function Screen({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-4">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <div className="flex flex-col items-start gap-4 text-neutral-300">{children}</div>
    </div>
  );
}
