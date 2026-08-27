import { randomUUID } from 'node:crypto';

import { HSUSD_MINT } from '@joinbankroll/sdk/server';
import { sortableId } from '@joinbankroll/sdk/store';
import { describe, expect, it } from 'vitest';

import { ChargeNotFound, getCharge, listCharges, recordCharge, updateCharge } from '@/lib/store';

// The charge store is the money path: a payment becomes a record the app owes
// against, exactly once, listable newest-first at any history size.
const wallet = () => `Wa11et${randomUUID().replaceAll('-', '')}`;
const signature = () => `Sig${randomUUID().replaceAll('-', '')}`;

describe('recordCharge', () => {
  it('records a charge and returns its id', async () => {
    const w = wallet();
    const s = signature();
    const { created, charge } = await recordCharge(w, s, 1000, 100, HSUSD_MINT);
    expect(created).toBe(true);
    expect(charge.id).toBe(sortableId(1000, s));
    expect(charge.status).toBe('held');
    expect(charge.amountCents).toBe(100);
  });

  it('is idempotent — a replayed signature returns the existing charge', async () => {
    const w = wallet();
    const s = signature();
    const first = await recordCharge(w, s, 1000, 100, HSUSD_MINT);
    const second = await recordCharge(w, s, 1000, 100, HSUSD_MINT);
    expect(second.created).toBe(false);
    expect(second.charge.id).toBe(first.charge.id);
  });

  it('records once when the same signature arrives concurrently', async () => {
    const w = wallet();
    const s = signature();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => recordCharge(w, s, 1000, 100, HSUSD_MINT)),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const { charges } = await listCharges(w);
    expect(charges).toHaveLength(1);
  });
});

describe('getCharge', () => {
  it('reads a charge by id', async () => {
    const w = wallet();
    const s = signature();
    const { charge } = await recordCharge(w, s, 1000, 100, HSUSD_MINT);
    expect((await getCharge(w, charge.id))?.signature).toBe(s);
  });

  it('returns null for an unknown id', async () => {
    expect(await getCharge(wallet(), sortableId(1, signature()))).toBeNull();
  });
});

describe('listCharges', () => {
  it('returns newest first, by slot', async () => {
    const w = wallet();
    // Record out of slot order on purpose.
    for (const slot of [30, 10, 50, 20, 40])
      await recordCharge(w, signature(), slot, 100, HSUSD_MINT);
    const { charges } = await listCharges(w);
    expect(charges.map((c) => c.id.split('-')[0])).toEqual(
      [...charges.map((c) => c.id.split('-')[0])].sort(),
    );
    // Highest slot is newest, so it comes first.
    expect(charges).toHaveLength(5);
  });

  it('pages through a long history with a cursor, newest first, no gaps or repeats', async () => {
    const w = wallet();
    const slots = Array.from({ length: 12 }, (_, i) => (i + 1) * 10);
    for (const slot of slots) await recordCharge(w, signature(), slot, 100, HSUSD_MINT);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listCharges(w, { limit: 5, cursor });
      expect(page.charges.length).toBeLessThanOrEqual(5);
      seen.push(...page.charges.map((c) => c.id));
      cursor = page.cursor;
    } while (cursor);

    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12); // no repeats
    // Descending slot order across page boundaries.
    const orderKeys = seen.map((id) => id.split('-')[0]);
    expect(orderKeys).toEqual([...orderKeys].sort());
  });

  it('is empty for a wallet that has been charged nothing', async () => {
    expect((await listCharges(wallet())).charges).toEqual([]);
  });
});

describe('updateCharge', () => {
  it('moves a charge through its lifecycle', async () => {
    const w = wallet();
    const { charge } = await recordCharge(w, signature(), 1000, 100, HSUSD_MINT);
    const paid = await updateCharge(w, charge.id, (c) => ({
      ...c,
      status: 'paid',
      paidAt: new Date().toISOString(),
    }));
    expect(paid.status).toBe('paid');
    expect((await getCharge(w, charge.id))?.status).toBe('paid');
  });

  it('throws for an unknown id', async () => {
    await expect(updateCharge(wallet(), sortableId(1, signature()), (c) => c)).rejects.toThrow(
      ChargeNotFound,
    );
  });

  it('pays out exactly once under concurrency', async () => {
    const w = wallet();
    const { charge } = await recordCharge(w, signature(), 1000, 100, HSUSD_MINT);
    // Many callers race to pay out; the transition must win exactly once.
    const payOut = () =>
      updateCharge(w, charge.id, (c) => {
        if (c.status === 'paid') throw new Error('already paid');
        return { ...c, status: 'paid' };
      }).then(
        () => 'won',
        () => 'lost',
      );
    const outcomes = await Promise.all(Array.from({ length: 8 }, payOut));
    expect(outcomes.filter((o) => o === 'won')).toHaveLength(1);
  });
});
