import { randomUUID } from 'node:crypto';

import { HSUSD_MINT } from '@joinbankroll/sdk/server';
import { describe, expect, it } from 'vitest';

import {
  buildId,
  getPurchase,
  listPurchases,
  PurchaseNotFound,
  recordPurchase,
  updatePurchase,
} from '@/lib/store';

// The purchase store is the money path: a payment becomes something the user
// owns, exactly once, and can be listed newest-first at any history size.
const wallet = () => `Wa11et${randomUUID().replaceAll('-', '')}`;
const signature = () => `Sig${randomUUID().replaceAll('-', '')}`;

describe('recordPurchase', () => {
  it('records a purchase and returns its id', async () => {
    const w = wallet();
    const s = signature();
    const { created, purchase } = await recordPurchase(w, s, 1000, 100, HSUSD_MINT);
    expect(created).toBe(true);
    expect(purchase.id).toBe(buildId(1000, s));
    expect(purchase.status).toBe('unconsumed');
    expect(purchase.amountCents).toBe(100);
  });

  it('is idempotent — a replayed signature returns the existing purchase', async () => {
    const w = wallet();
    const s = signature();
    const first = await recordPurchase(w, s, 1000, 100, HSUSD_MINT);
    const second = await recordPurchase(w, s, 1000, 100, HSUSD_MINT);
    expect(second.created).toBe(false);
    expect(second.purchase.id).toBe(first.purchase.id);
  });

  it('records once when the same signature arrives concurrently', async () => {
    const w = wallet();
    const s = signature();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => recordPurchase(w, s, 1000, 100, HSUSD_MINT)),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const { purchases } = await listPurchases(w);
    expect(purchases).toHaveLength(1);
  });
});

describe('getPurchase', () => {
  it('reads a purchase by id', async () => {
    const w = wallet();
    const s = signature();
    const { purchase } = await recordPurchase(w, s, 1000, 100, HSUSD_MINT);
    expect((await getPurchase(w, purchase.id))?.signature).toBe(s);
  });

  it('returns null for an unknown id', async () => {
    expect(await getPurchase(wallet(), buildId(1, signature()))).toBeNull();
  });
});

describe('listPurchases', () => {
  it('returns newest first, by slot', async () => {
    const w = wallet();
    // Record out of slot order on purpose.
    for (const slot of [30, 10, 50, 20, 40]) await recordPurchase(w, signature(), slot, 100, HSUSD_MINT);
    const { purchases } = await listPurchases(w);
    expect(purchases.map((p) => p.id.split('-')[0])).toEqual(
      [...purchases.map((p) => p.id.split('-')[0])].sort(),
    );
    // Highest slot is newest, so it comes first.
    expect(purchases).toHaveLength(5);
  });

  it('pages through a long history with a cursor, newest first, no gaps or repeats', async () => {
    const w = wallet();
    const slots = Array.from({ length: 12 }, (_, i) => (i + 1) * 10);
    for (const slot of slots) await recordPurchase(w, signature(), slot, 100, HSUSD_MINT);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listPurchases(w, { limit: 5, cursor });
      expect(page.purchases.length).toBeLessThanOrEqual(5);
      seen.push(...page.purchases.map((p) => p.id));
      cursor = page.cursor;
    } while (cursor);

    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12); // no repeats
    // Descending slot order across page boundaries.
    const orderKeys = seen.map((id) => id.split('-')[0]);
    expect(orderKeys).toEqual([...orderKeys].sort());
  });

  it('is empty for a wallet that has bought nothing', async () => {
    expect((await listPurchases(wallet())).purchases).toEqual([]);
  });
});

describe('updatePurchase', () => {
  it('moves a purchase through its lifecycle', async () => {
    const w = wallet();
    const { purchase } = await recordPurchase(w, signature(), 1000, 100, HSUSD_MINT);
    const consumed = await updatePurchase(w, purchase.id, (p) => ({
      ...p,
      status: 'consumed',
      consumedAt: new Date().toISOString(),
    }));
    expect(consumed.status).toBe('consumed');
    expect((await getPurchase(w, purchase.id))?.status).toBe('consumed');
  });

  it('throws for an unknown id', async () => {
    await expect(updatePurchase(wallet(), buildId(1, signature()), (p) => p)).rejects.toThrow(
      PurchaseNotFound,
    );
  });

  it('consumes exactly once under concurrency', async () => {
    const w = wallet();
    const { purchase } = await recordPurchase(w, signature(), 1000, 100, HSUSD_MINT);
    // Many callers race to consume; the transition must win exactly once.
    const consume = () =>
      updatePurchase(w, purchase.id, (p) => {
        if (p.status === 'consumed') throw new Error('already consumed');
        return { ...p, status: 'consumed' };
      }).then(
        () => 'won',
        () => 'lost',
      );
    const outcomes = await Promise.all(Array.from({ length: 8 }, consume));
    expect(outcomes.filter((o) => o === 'won')).toHaveLength(1);
  });
});
