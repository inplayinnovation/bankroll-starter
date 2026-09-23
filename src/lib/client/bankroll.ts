'use client';

// This app's client half: what it knows about you, and the host.
//
// Talking to the host — attaching the session token, knowing whether Bankroll
// is even there, sending someone through verification — is the same in every
// app, so it comes from @joinbankroll/sdk/react rather than living here.
import { bankrollFetch } from '@joinbankroll/sdk/react';
import type { Restriction } from '@joinbankroll/sdk/restrictions';
import { useCallback, useEffect, useState } from 'react';

export {
  bankrollFetch,
  useBankrollChecked,
  useBankrollStatus,
  verifyIdentity,
} from '@joinbankroll/sdk/react';

export interface Me {
  username: string;
  wallet: string;
  identified: boolean;
  /** Present only when the user's date of birth is on file. */
  age: number | null;
  /** Where the user is for this session — not where they live. */
  geo: string | null;
  /**
   * The server's decision on paid play. Keep paid actions disabled while
   * `reason` is set, and say why: the location, or the age.
   */
  restriction: Restriction;
  /** A payee is configured, so charges work. */
  paymentsConfigured: boolean;
  /** This app's own tokens. Empty when it issues none. */
  appTokens: { mint: string; name: string }[];
}

async function fetchMe(): Promise<Me | null> {
  const response = await bankrollFetch('/api/me');
  return response.ok ? ((await response.json()) as Me) : null;
}

export function useMe(): { me: Me | null; refresh: () => Promise<void> } {
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    // Ignore a response that arrives after this component is gone, or after a
    // newer request has already been issued.
    let cancelled = false;
    void fetchMe().then((next) => {
      if (!cancelled) setMe(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => setMe(await fetchMe()), []);
  return { me, refresh };
}
