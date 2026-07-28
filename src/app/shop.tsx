'use client';

// The app's surface. It is NOT a wallet — the Bankroll host is the wallet, and
// holds the user's money, identity, and location. This app just sells loot
// boxes and remembers what was bought. Everything here runs inside the Bankroll
// app; in a plain browser it tells a developer where to go instead.
import { useState } from 'react';

import {
  buy,
  open,
  useBankrollChecked,
  useBankrollStatus,
  useMe,
  usePurchases,
  verifyIdentity,
  type Purchase,
} from '@/lib/client/bankroll';

export function Shop({ ready, devTools }: { ready: boolean; devTools?: React.ReactNode }) {
  const status = useBankrollStatus();
  const { me } = useMe();
  const { purchases, refresh } = usePurchases();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // The host bridge only exists in the browser, so a server render always reads
  // 'unavailable'. Deciding anything on that would flash "open this in Bankroll"
  // at a phone that is already inside Bankroll, until hydration corrects it —
  // so wait until the status has actually been looked at.
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

  if (!me) return <Loading />;

  const run = async (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true);
    setMessage(null);
    const result = await action();
    if (result.error) setMessage(result.error);
    await refresh();
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-neutral-400">@{me.username}</span>
        {/* The two things Bankroll knows about a user that a real-money app has
            to act on: whether they're a verified person, and where they are
            right now. Both come from the signed session, never the client. */}
        <Verified verified={me.identified} />
        {me.geo && <Tag>{me.geo}</Tag>}
      </header>

      {/* Real money moves only for a verified identity — prompt for it rather
          than letting the charge fail. */}
      {!me.identified ? (
        <button
          className="btn"
          disabled={busy}
          onClick={() => run(async () => ({ ok: await verifyIdentity() }))}
        >
          Verify your identity to continue
        </button>
      ) : (
        <>
          <button className="btn" disabled={busy} onClick={() => run(() => buy())}>
            Buy a loot box — $1.00
          </button>

          {/* Paying with the app's own token, when it issues one. Opening pays
              back in whatever bought it, so this box costs tokens and returns
              tokens — free credit never becomes real money. */}
          {me.appToken && (
            <button
              className="btn"
              disabled={busy}
              onClick={() => run(() => buy(me.appToken!.mint))}
            >
              Buy with {me.appToken.name}
            </button>
          )}

          <section className="flex flex-col gap-2">
            <h2 className="text-sm tracking-wide text-neutral-400 uppercase">Your loot boxes</h2>
            {purchases.length === 0 ? (
              <p className="text-sm text-neutral-500">None yet. Buy one — opening it pays $1 back.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {purchases.map((purchase) => (
                  <LootBox
                    key={purchase.id}
                    purchase={purchase}
                    busy={busy}
                    onOpen={() => run(() => open(purchase.id))}
                  />
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {message && <p className="text-sm text-amber-400">{message}</p>}

      {/* Only reached inside the Bankroll app, which is the only place the app
          runs and so the only place these tools have anything to say. */}
      {devTools}
    </div>
  );
}

function LootBox({
  purchase,
  busy,
  onOpen,
}: {
  purchase: Purchase;
  busy: boolean;
  onOpen: () => void;
}) {
  return (
    <li className="flex items-center justify-between rounded-xl border border-neutral-800 px-4 py-3">
      <span className="font-mono text-xs text-neutral-500">
        {purchase.signature.slice(0, 4)}…{purchase.signature.slice(-4)}
      </span>
      {purchase.status === 'unconsumed' && (
        <button className="btn" disabled={busy} onClick={onOpen}>
          Open
        </button>
      )}
      {purchase.status === 'consuming' && <Tag>paying…</Tag>}
      {purchase.status === 'consumed' && <span className="text-sm text-emerald-400">+$1.00 ✓</span>}
      {purchase.status === 'failed' && <span className="text-sm text-amber-400">failed</span>}
    </li>
  );
}

function Loading() {
  return <p className="text-neutral-400">Loading…</p>;
}

// A mark rather than a word: it sits beside the handle the way a verification
// badge does anywhere else, and the prompt to fix it is already below.
function Verified({ verified }: { verified: boolean }) {
  return (
    <span
      aria-label={verified ? 'Identity verified' : 'Identity not verified'}
      className={`flex size-4 items-center justify-center rounded-full text-[10px] ${
        verified ? 'bg-emerald-400/15 text-emerald-400' : 'bg-amber-400/15 text-amber-400'
      }`}
      title={verified ? 'Identity verified' : 'Identity not verified'}
    >
      {verified ? '✓' : '?'}
    </span>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-300">
      {children}
    </span>
  );
}

function Screen({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-4">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <div className="flex flex-col items-start gap-4 text-neutral-300">{children}</div>
    </div>
  );
}
