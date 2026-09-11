'use client';

import { useBalances } from '@/lib/client/balances';

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const tokens = new Intl.NumberFormat('en-US', { maximumFractionDigits: 9 });

/** Mount inside Gate. Cash and app credits share a dollar balance. */
export function BankrollBalances() {
  const state = useBalances();

  return (
    <dl aria-label="Bankroll balances" className="min-w-0 space-y-2 text-right">
      <div>
        <dt className="text-xs text-neutral-400">
          Bankroll <span className="sr-only">balance</span>
        </dt>
        <dd className="text-sm font-semibold tabular-nums">
          {state.status === 'ready' ? (
            dollars.format((state.balances.cashCents + state.balances.creditsCents) / 100)
          ) : (
            <span className="font-normal text-neutral-400">
              {state.status === 'loading' ? 'Loading…' : 'Unavailable'}
            </span>
          )}
        </dd>
        {state.status === 'update_required' && (
          <dd className="text-xs text-neutral-400">Update Bankroll to see your balance.</dd>
        )}
      </div>
      {state.balances &&
        Object.entries(state.balances.tokens).map(([mint, token]) => (
          <Balance key={mint} label={token.name} amount={tokens.format(token.amount)} />
        ))}
    </dl>
  );
}

function Balance({ label, amount }: { label: string; amount: string }) {
  return (
    <div className="text-xs">
      <dt className="wrap-anywhere text-neutral-400">{label}</dt>
      <dd className="tabular-nums">{amount}</dd>
    </div>
  );
}
