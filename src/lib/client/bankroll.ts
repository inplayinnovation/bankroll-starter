'use client';

// This app's client half: the two money calls, and what it knows about you.
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

// Mirrors the server's Charge, minus fields the UI doesn't read.
export interface Charge {
  id: string;
  signature: string;
  amountCents: number;
  status: 'held' | 'paying' | 'paid' | 'failed';
  chargedAt: string;
  /**
   * Set when a payout was broadcast but did not confirm. `expired` means it
   * never landed and never will, so trying again is safe and rebuilds it —
   * without this the UI cannot tell a payout in flight from a dead one.
   */
  payout?: { error?: string };
}

async function fetchCharges(): Promise<Charge[]> {
  const response = await bankrollFetch('/api/charges');
  return response.ok ? ((await response.json()) as { charges: Charge[] }).charges : [];
}

export function useCharges(): { charges: Charge[]; refresh: () => Promise<void> } {
  const [charges, setCharges] = useState<Charge[]>([]);

  useEffect(() => {
    let cancelled = false;
    void fetchCharges().then((next) => {
      if (!cancelled) setCharges(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => setCharges(await fetchCharges()), []);
  return { charges, refresh };
}

/**
 * Take money: ask the host to charge the user, then hand the signature to the
 * server, which confirms it on-chain and records it.
 *
 * The idempotency key names this one charge, so a retry after an interrupted
 * payment recovers the same one rather than charging twice. It is generated per
 * call — never shared — so two charges are two payments while a retry of one
 * charge is not.
 */
export async function charge(token?: string): Promise<{ ok: boolean; error?: string }> {
  const idempotencyKey = crypto.randomUUID();
  try {
    // `token` names one of the app's own declared mints; omitted, the charge
    // settles in HSUSD. Either way the server checks which asset actually paid
    // before it records anything.
    const signature = await bankroll.charge({ amountCents: CHARGE_CENTS, idempotencyKey, token });
    const response = await bankrollFetch('/api/charges', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signature }),
    });
    if (!response.ok) {
      const body = (await response.json()) as { error?: string };
      return { ok: false, error: body.error ?? 'charge failed' };
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

/** Send money: pay a charge back out to the wallet that made it. */
export async function payOut(id: string): Promise<{ ok: boolean; error?: string }> {
  const response = await bankrollFetch(`/api/charges/${encodeURIComponent(id)}/payout`, {
    method: 'POST',
  });
  // 202 means the payout was broadcast but did not confirm in time. It may
  // still land, so this is not a failure — but it is not done either, and
  // saying nothing leaves the row sitting on "paying…" with no explanation.
  if (response.status === 202) return { ok: false, error: 'still settling — try again shortly' };
  if (response.ok) return { ok: true };
  const body = (await response.json()) as { error?: string };
  return { ok: false, error: body.error ?? 'could not pay out' };
}

// What the demo charges, in cents — matches the server's PRICE_CENTS.
const CHARGE_CENTS = 100;
