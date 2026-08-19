'use client';

// The app's surface — and, in the starter, a tour of what the host gives you.
//
// It is NOT a wallet: the Bankroll host holds the user's money, identity, and
// location. This app only reads what the host signed and moves money in and out.
// Everything here runs inside the Bankroll app; in a plain browser it tells a
// developer where to go instead.
//
// Delete this file when you start building. What it demonstrates — the session
// claims, `charge()`, and the payout — is the part to carry over.
import { useState } from 'react';

import {
  charge,
  payOut,
  useBankrollChecked,
  useBankrollStatus,
  useCharges,
  useMe,
  verifyIdentity,
  type Charge,
  type Me,
} from '@/lib/client/bankroll';

const CHARGE_LABEL = '$0.01';

export function Demo({ ready, devTools }: { ready: boolean; devTools?: React.ReactNode }) {
  const status = useBankrollStatus();
  const { me } = useMe();
  const { charges, refresh } = useCharges();
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
        <Verified verified={me.identified} />
        {me.geo && <Tag>{me.geo}</Tag>}
      </header>

      <Session me={me} />

      <Section
        title="Charge"
        caption="bankroll.charge() asks the host to move money. The server then checks who paid, how much, and in what, before recording it."
      >
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
            <button className="btn" disabled={busy} onClick={() => run(() => charge())}>
              Charge {CHARGE_LABEL}
            </button>

            {/* Paying with the app's own tokens, when it issues any. The payout
                returns whatever paid, so a token charge pays back tokens — free
                credit never becomes real money. */}
            {me.appTokens.map((token) => (
              <button
                className="btn"
                disabled={busy}
                key={token.mint}
                onClick={() => run(() => charge(token.mint))}
              >
                Charge 1 {token.name}
              </button>
            ))}
          </>
        )}
      </Section>

      <Section
        title="Charges"
        caption="Paying out returns the same amount, in whatever asset paid — so the loop runs as often as you like."
      >
        {charges.length === 0 ? (
          <p className="text-sm text-neutral-500">Nothing charged yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {charges.map((item) => (
              <ChargeRow
                key={item.id}
                charge={item}
                busy={busy}
                onPayOut={() => run(() => payOut(item.id))}
              />
            ))}
          </ul>
        )}
      </Section>

      {message && <p className="text-sm text-amber-400">{message}</p>}

      {/* Only reached inside the Bankroll app, which is the only place the app
          runs and so the only place these tools have anything to say. */}
      {devTools}
    </div>
  );
}

/**
 * Everything this app knows about the person using it — all of it read
 * server-side from the host's signed token, none of it sent by the client.
 * That is the whole identity story: an app never asks who you are.
 */
function Session({ me }: { me: Me }) {
  return (
    <Section
      title="From the signed session"
      caption="Read server-side from the host's token. The client never sends these, so it cannot lie about them."
    >
      <dl className="flex flex-col gap-2 text-sm">
        <Claim label="wallet">
          <Copyable value={me.wallet} />
        </Claim>
        <Claim label="identity">
          {me.identified ? (
            <span className="text-emerald-400">verified</span>
          ) : (
            <span className="text-amber-400">not verified</span>
          )}
        </Claim>
        <Claim label="location">{me.geo ?? <Absent>not reported</Absent>}</Claim>
        <Claim label="age">{me.age ?? <Absent>not on file</Absent>}</Claim>
      </dl>
    </Section>
  );
}

function Claim({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

function Absent({ children }: { children: React.ReactNode }) {
  return <span className="text-neutral-600">{children}</span>;
}

/**
 * The full value is what gets copied; the display is shortened because a wallet
 * address does not fit a phone's width.
 */
function Copyable({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      className="font-mono text-xs text-neutral-300 transition hover:text-neutral-100"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      title={value}
      type="button"
    >
      {copied ? 'copied' : `${value.slice(0, 8)}…${value.slice(-6)}`}
    </button>
  );
}

function ChargeRow({
  charge,
  busy,
  onPayOut,
}: {
  charge: Charge;
  busy: boolean;
  onPayOut: () => void;
}) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-xl border border-neutral-800 px-4 py-3">
      <span className="font-mono text-xs text-neutral-500">
        {charge.signature.slice(0, 4)}…{charge.signature.slice(-4)}
      </span>
      {charge.status === 'held' && (
        <button className="btn" disabled={busy} onClick={onPayOut}>
          Pay out
        </button>
      )}
      {/* Any recorded payout error is safe to retry: the route resolves the
          stored signature first, so a retry can only confirm, prove the
          attempt dead and rebuild, or keep waiting — never pay twice. */}
      {charge.status === 'paying' &&
        (charge.payout?.error ? (
          <button className="btn" disabled={busy} onClick={onPayOut}>
            Retry payout
          </button>
        ) : (
          <Tag>paying…</Tag>
        ))}
      {charge.status === 'paid' && <span className="text-sm text-emerald-400">paid out ✓</span>}
      {charge.status === 'failed' && <span className="text-sm text-amber-400">failed</span>}
    </li>
  );
}

function Section({
  title,
  caption,
  children,
}: {
  title: string;
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-xs tracking-wide text-neutral-400 uppercase">{title}</h2>
        <p className="text-xs text-neutral-600">{caption}</p>
      </div>
      {children}
    </section>
  );
}

function Loading() {
  return <p className="text-neutral-400">Loading…</p>;
}

// A mark rather than a word: it sits beside the handle the way a verification
// badge does anywhere else, and the session card spells it out below.
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
