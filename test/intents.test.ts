import { randomUUID } from 'node:crypto';

import { HSUSD_MINT } from '@joinbankroll/sdk/server';
import { describe, expect, it, vi } from 'vitest';

import { listRecentIntents, recordIntent, recordCharge, resolveIntent } from '@/lib/store';

// An intent is the note that makes a payment findable when the page never got
// to report it. What matters is that no attempt is ever lost, that the sweep's
// walk is bounded by time rather than by luck, and that recovering a charge
// cannot record it twice.
const wallet = () => `Wa11et${randomUUID().replaceAll('-', '')}`;
const reference = () => `Ref${randomUUID().replaceAll('-', '')}`;
const signature = () => `Sig${randomUUID().replaceAll('-', '')}`;

const MINUTE = 60 * 1000;

describe('recordIntent', () => {
  it('keeps every attempt — a second charge cannot erase the first', async () => {
    const w = wallet();
    const first = await recordIntent(w, reference(), randomUUID(), 100);
    const second = await recordIntent(w, reference(), randomUUID(), 100);

    const recent = await listRecentIntents(w, MINUTE);
    expect(recent.map((intent) => intent.id).sort()).toEqual([first.id, second.id].sort());
  });

  it('carries the reference and the key the charge will be made with', async () => {
    const w = wallet();
    const ref = reference();
    const key = randomUUID();
    const intent = await recordIntent(w, ref, key, 100);

    expect(intent.reference).toBe(ref);
    expect(intent.paymentKey).toBe(key);
    expect(intent.resolved).toBeUndefined();
  });
});

describe('listRecentIntents', () => {
  it('returns attempts newest first', async () => {
    const w = wallet();
    const older = await recordIntent(w, reference(), randomUUID(), 100);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const newer = await recordIntent(w, reference(), randomUUID(), 100);

    const recent = await listRecentIntents(w, MINUTE);
    expect(recent[0]!.id).toBe(newer.id);
    expect(recent[1]!.id).toBe(older.id);
  });

  // The walk stops at the first attempt too old to still be in flight, so it is
  // bounded by how many charges were started recently — never by history. Past
  // the window a payment has settled or died with its blockhash, so there is
  // nothing left worth asking the chain about.
  it('leaves behind attempts too old to still be in flight', async () => {
    const w = wallet();
    await recordIntent(w, reference(), randomUUID(), 100);
    expect(await listRecentIntents(w, MINUTE)).toHaveLength(1);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 5 * MINUTE);
      expect(await listRecentIntents(w, MINUTE)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('scopes to one wallet', async () => {
    const mine = wallet();
    const theirs = wallet();
    await recordIntent(mine, reference(), randomUUID(), 100);
    await recordIntent(theirs, reference(), randomUUID(), 100);

    expect(await listRecentIntents(mine, MINUTE)).toHaveLength(1);
  });
});

describe('resolveIntent', () => {
  it('marks an attempt answered so the sweep stops asking', async () => {
    const w = wallet();
    const intent = await recordIntent(w, reference(), randomUUID(), 100);

    await resolveIntent(w, intent.id);

    const [stored] = await listRecentIntents(w, MINUTE);
    expect(stored!.resolved).toBe(true);
  });

  // The charge is recorded either way; this only saves a later lookup.
  it('does not throw for an intent that is not there', async () => {
    await expect(resolveIntent(wallet(), 'missing')).resolves.toBeUndefined();
  });
});

// The reason the sweep needs no locking: both paths derive the same id from the
// transaction, so the atomic create collapses them.
describe('recovering a charge the page never reported', () => {
  it('converges on the one document the live path would have written', async () => {
    const w = wallet();
    const s = signature();

    // The page reported it...
    const live = await recordCharge(w, s, 1000, 100, HSUSD_MINT);
    // ...and a sweep found the same payment on-chain afterwards.
    const swept = await recordCharge(w, s, 1000, 100, HSUSD_MINT);

    expect(live.created).toBe(true);
    expect(swept.created).toBe(false);
    expect(swept.charge.id).toBe(live.charge.id);
  });

  it('records the charge when only the sweep ever sees it', async () => {
    const w = wallet();
    const swept = await recordCharge(w, signature(), 1000, 100, HSUSD_MINT);
    expect(swept.created).toBe(true);
    expect(swept.charge.status).toBe('held');
  });
});
