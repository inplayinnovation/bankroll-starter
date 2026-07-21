'use client';

// The client half: talking to the Bankroll app that hosts this page.
import { bankroll, BankrollError, withBankrollToken, type BankrollStatus } from '@joinbankroll/sdk';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

/**
 * Every authenticated request carries the session token. `fetch` is bound
 * because it throws when called detached from the window.
 */
export const bankrollFetch = withBankrollToken(
  typeof window === 'undefined' ? fetch : fetch.bind(window),
);

// The host is injected before the page loads and never changes afterwards, so
// there is nothing to subscribe to. On the server there is no host, which is
// the same answer a plain browser tab gets — so server and client agree and
// the gate always renders something rather than blanking.
const noSubscribe = () => () => {};
const unavailable = (): BankrollStatus => 'unavailable';

/**
 * Host status: 'ready' inside a current Bankroll app, 'update_required' inside
 * one too old for this SDK, 'unavailable' anywhere else — including during
 * server render.
 */
export function useBankrollStatus(): BankrollStatus {
  return useSyncExternalStore(noSubscribe, bankroll.status, unavailable);
}

export interface Me {
  username: string;
  wallet: string;
  identified: boolean;
  /** Present only when the user's date of birth is on file. */
  age: number | null;
  /** Where the user is for this session — not where they live. */
  geo: string | null;
  treasuryConfigured: boolean;
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
export async function buy(): Promise<{ ok: boolean; error?: string }> {
  const idempotencyKey = crypto.randomUUID();
  try {
    const signature = await bankroll.charge({ amountCents: PRICE_CENTS, idempotencyKey });
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

/** Verify identity — real money moves only for a verified person. */
export async function verifyIdentity(): Promise<boolean> {
  try {
    await bankroll.session({ identity: true });
    return true;
  } catch (error) {
    if (error instanceof BankrollError) return false;
    throw error;
  }
}

// The loot box price, in cents — matches the server's PRICE_CENTS.
const PRICE_CENTS = 100;
