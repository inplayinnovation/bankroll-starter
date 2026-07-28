'use client';

// This app's client half: what it sells and how it asks for it.
//
// Talking to the host — attaching the session token, knowing whether Bankroll
// is even there, sending someone through verification — is the same in every
// app, so it comes from @joinbankroll/sdk/react rather than living here.
import { bankroll, BankrollError } from '@joinbankroll/sdk';
import { bankrollFetch } from '@joinbankroll/sdk/react';
import { useCallback, useEffect, useState } from 'react';

export { bankrollFetch, useBankrollChecked, useBankrollStatus, verifyIdentity } from '@joinbankroll/sdk/react';

export interface Me {
  username: string;
  wallet: string;
  identified: boolean;
  /** Present only when the user's date of birth is on file. */
  age: number | null;
  /** Where the user is for this session — not where they live. */
  geo: string | null;
  treasuryConfigured: boolean;
  /** This app's own token, when it issues one. Null when it doesn't. */
  appToken: { mint: string; name: string } | null;
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

// Mirrors the server's Purchase, minus fields the UI doesn't read.
export interface Purchase {
  id: string;
  signature: string;
  amountCents: number;
  status: 'unconsumed' | 'consuming' | 'consumed' | 'failed';
  purchasedAt: string;
}

async function fetchPurchases(): Promise<Purchase[]> {
  const response = await bankrollFetch('/api/purchases');
  return response.ok ? ((await response.json()) as { purchases: Purchase[] }).purchases : [];
}

export function usePurchases(): { purchases: Purchase[]; refresh: () => Promise<void> } {
  const [purchases, setPurchases] = useState<Purchase[]>([]);

  useEffect(() => {
    let cancelled = false;
    void fetchPurchases().then((next) => {
      if (!cancelled) setPurchases(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => setPurchases(await fetchPurchases()), []);
  return { purchases, refresh };
}

/**
 * Buy: charge the user, then hand the signature to the server, which confirms
 * it on-chain and records the purchase.
 *
 * The idempotency key names this one purchase, so a retry after an interrupted
 * charge recovers the same payment rather than charging twice. It is generated
 * per call — never shared across purchases — so two buys are two payments while
 * a retry of one buy is not.
 */
export async function buy(token?: string): Promise<{ ok: boolean; error?: string }> {
  const idempotencyKey = crypto.randomUUID();
  try {
    // `token` names one of the app's own declared mints; omitted, the charge
    // settles in HSUSD. Either way the server checks which asset actually paid
    // before it releases anything.
    const signature = await bankroll.charge({ amountCents: PRICE_CENTS, idempotencyKey, token });
    const response = await bankrollFetch('/api/purchases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signature }),
    });
    if (!response.ok) {
      const body = (await response.json()) as { error?: string };
      return { ok: false, error: body.error ?? 'purchase failed' };
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof BankrollError) {
      // The user declining or lacking funds is their own decision — Bankroll
      // already told them, so there is nothing for the app to surface.
      if (error.code === 'insufficient_funds' || error.code === 'payment_denied') {
        return { ok: false };
      }
      return { ok: false, error: error.code };
    }
    throw error;
  }
}

/** Open a loot box: consume the purchase and pay the reward to the wallet. */
export async function open(id: string): Promise<{ ok: boolean; error?: string }> {
  const response = await bankrollFetch(`/api/purchases/${encodeURIComponent(id)}/consume`, {
    method: 'POST',
  });
  // 202 means the payout was broadcast but not yet confirmed — it may still
  // land, so it counts as underway rather than failed.
  if (response.ok || response.status === 202) return { ok: true };
  const body = (await response.json()) as { error?: string };
  return { ok: false, error: body.error ?? 'could not open' };
}

// The loot box price, in cents — matches the server's PRICE_CENTS.
const PRICE_CENTS = 100;
