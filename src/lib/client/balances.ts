'use client';

import { bankroll, BankrollError, type Balances } from '@joinbankroll/sdk';
import { useEffect, useState } from 'react';

const REFRESH_MS = 2_000;

type BalanceState =
  | { status: 'loading'; balances: null }
  | { status: 'ready'; balances: Balances }
  | { status: 'unavailable' | 'update_required'; balances: null };

/** Display only. A settled charge and the server's records authorize value. */
export function useBalances(): BalanceState {
  const [state, setState] = useState<BalanceState>({ status: 'loading', balances: null });

  useEffect(() => {
    let cancelled = false;
    let pending = false;
    let unsupported = false;

    async function refresh() {
      if (cancelled || pending || unsupported || document.visibilityState === 'hidden') return;
      pending = true;
      try {
        const balances = await bankroll.balances();
        if (!cancelled) setState({ status: 'ready', balances });
      } catch (error) {
        unsupported = error instanceof BankrollError && error.code === 'update_required';
        // A failed read is not a zero balance. Clear the old amount so it
        // cannot look current after a charge, payout, or deposit.
        if (!cancelled) {
          setState({ status: unsupported ? 'update_required' : 'unavailable', balances: null });
        }
      } finally {
        pending = false;
      }
    }

    // The host answers from its live balance store, without an upstream fetch.
    // Polling also catches native deposits that settle after their sheet closes.
    void refresh();
    const interval = window.setInterval(() => void refresh(), REFRESH_MS);
    const onReturn = () => void refresh();
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, []);

  return state;
}
