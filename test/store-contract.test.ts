import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { PreconditionFailed, type StoreBackend } from '@/lib/store/backend';
import { blobBackend } from '@/lib/store/blob';
import { fsBackend } from '@/lib/store/fs';

// One set of assertions, run against every backend. Vercel Blob is what a
// deployment uses, so it defines correct and the filesystem mirrors it — the
// point of running identical tests is that any divergence shows up as the same
// case passing for one and failing for the other, instead of being a claim in a
// comment.
//
// Blob runs only when DANGEROUS_BLOB_TOKEN is set, and never reads
// BLOB_READ_WRITE_TOKEN — that is the variable a real deployment uses and that
// `vercel env pull` writes, so the suite must not be able to reach a production
// store by accident. Everything it writes lives under `conformance/`.
const PREFIX = 'conformance';

function contract(backend: StoreBackend) {
  const path = () => `${PREFIX}/${randomUUID()}.json`;

  it('reads null for a document that does not exist', async () => {
    expect(await backend.readJson(path())).toBeNull();
  });

  it('round-trips a document and reports an etag', async () => {
    const p = path();
    expect(await backend.createIfAbsent(p, { n: 1 })).toBe(true);
    const stored = await backend.readJson<{ n: number }>(p);
    expect(stored?.value.n).toBe(1);
    expect(stored?.etag).toBeTruthy();
  });

  it('reads its own write immediately', async () => {
    // Blob is CDN-fronted and can serve up to 60s stale unless reads opt out.
    // Read-modify-write on a balance is unsafe if this is not true.
    const p = path();
    await backend.createIfAbsent(p, { n: 1 });
    const first = await backend.readJson<{ n: number }>(p);
    await backend.writeJson(p, { n: 2 }, first!.etag);
    expect((await backend.readJson<{ n: number }>(p))?.value.n).toBe(2);
  });

  it('creates only if absent', async () => {
    const p = path();
    expect(await backend.createIfAbsent(p, { n: 1 })).toBe(true);
    expect(await backend.createIfAbsent(p, { n: 2 })).toBe(false);
    expect((await backend.readJson<{ n: number }>(p))?.value.n).toBe(1);
  });

  it('has exactly one winner when many callers create the same path', async () => {
    // The replay guard. Spending a payment signature must be something no two
    // requests can both succeed at.
    const p = path();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => backend.createIfAbsent(p, { n: 1 })),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('accepts a conditional write when the etag still matches', async () => {
    const p = path();
    await backend.createIfAbsent(p, { n: 1 });
    const stored = await backend.readJson<{ n: number }>(p);
    await backend.writeJson(p, { n: 2 }, stored!.etag);
    expect((await backend.readJson<{ n: number }>(p))?.value.n).toBe(2);
  });

  it('rejects a conditional write with a stale etag', async () => {
    const p = path();
    await backend.createIfAbsent(p, { n: 1 });
    const first = await backend.readJson<{ n: number }>(p);
    await backend.writeJson(p, { n: 2 }, first!.etag);
    await expect(backend.writeJson(p, { n: 99 }, first!.etag)).rejects.toThrow(PreconditionFailed);
    expect((await backend.readJson<{ n: number }>(p))?.value.n).toBe(2);
  });

  it('has exactly one winner when many callers compare-and-swap the same document', async () => {
    const p = path();
    await backend.createIfAbsent(p, { n: 0 });
    const stored = await backend.readJson<{ n: number }>(p);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => backend.writeJson(p, { n: i + 1 }, stored!.etag)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  // list is where the two backends diverge most — Blob has a native cursor,
  // the filesystem emulates one over sorted names — so it needs the closest
  // watching. A separate prefix per test keeps their listings isolated.
  const prefix = () => `${PREFIX}/list-${randomUUID()}`;

  it('lists nothing under an empty prefix', async () => {
    const { items, cursor } = await backend.list(prefix());
    expect(items).toEqual([]);
    expect(cursor).toBeUndefined();
  });

  it('returns documents in ascending key order', async () => {
    const p = prefix();
    // Write out of order; the listing must still come back by key.
    for (const key of ['c', 'a', 'd', 'b']) await backend.createIfAbsent(`${p}/${key}.json`, { key });
    const { items } = await backend.list<{ key: string }>(p);
    expect(items.map((i) => i.key)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('pages with a cursor: every document once, in order, then stops', async () => {
    const p = prefix();
    const keys = Array.from({ length: 12 }, (_, i) => String(i).padStart(2, '0'));
    for (const key of keys) await backend.createIfAbsent(`${p}/${key}.json`, { key });

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await backend.list<{ key: string }>(p, { limit: 5, cursor });
      expect(page.items.length).toBeLessThanOrEqual(5);
      seen.push(...page.items.map((i) => i.key));
      cursor = page.cursor;
      pages += 1;
      expect(pages).toBeLessThan(10); // guard against a cursor that never ends
    } while (cursor);

    expect(seen).toEqual(keys); // every key once, in order, no repeats or gaps
  });

  it('omits the cursor once the prefix is exhausted', async () => {
    const p = prefix();
    for (const key of ['a', 'b']) await backend.createIfAbsent(`${p}/${key}.json`, { key });
    const { cursor } = await backend.list(p, { limit: 5 });
    expect(cursor).toBeUndefined();
  });
}

describe('filesystem backend', () => {
  contract(fsBackend);
});

// Documented separately rather than folded in, because what Blob does here is
// the question — and the answer is what the filesystem is then held to.
const blobToken = process.env.DANGEROUS_BLOB_TOKEN;

// The SDK reads its token from the environment. Assigned here, from the
// deliberately-distinct variable, so the suite can never pick up a production
// token that happens to be present.
if (blobToken) process.env.BLOB_READ_WRITE_TOKEN = blobToken;

describe.skipIf(!blobToken)('vercel blob backend', () => {
  contract(blobBackend);
});

// One filesystem-specific behaviour with no Blob equivalent, so it can't be a
// shared contract case: writeFile truncates before writing, and a reader must
// never see the gap. Blob is one atomic PUT, so this cannot arise there.
describe('filesystem backend: atomic writes', () => {
  // writeFile truncates before it writes, so a reader arriving mid-write can
  // see an empty or half-written file and throw on JSON.parse. Every read must
  // return either the previous document or the next one — never a fragment.
  it('never observes a partially written document', async () => {
    const p = `torn/${randomUUID()}.json`;
    // Large enough that one write is several operations, so a reader has a
    // window to arrive mid-write.
    const FILLER = 40_000;
    const document = (marker: number) => ({ marker, filler: 'x'.repeat(FILLER) });

    await fsBackend.createIfAbsent(p, document(0));

    // Each round races one in-flight write against a burst of reads. Issuing
    // every write and read in a single batch does NOT reproduce this: writes
    // serialise through the per-path lock, so the reads land between them
    // rather than during one.
    const observed: { marker: number; filler: string }[] = [];
    for (let round = 1; round <= 20; round++) {
      const write = fsBackend.writeJson(p, document(round));
      const reads = Array.from({ length: 20 }, async () => {
        const stored = await fsBackend.readJson<{ marker: number; filler: string }>(p);
        if (stored) observed.push(stored.value);
      });
      await Promise.all([write, ...reads]);
    }

    // A read either returns the previous document or the next one. Anything
    // else means a reader saw a truncated file — which surfaces as readJson
    // throwing on JSON.parse, failing this test before it reaches here.
    expect(observed.length).toBeGreaterThan(0);
    for (const value of observed) {
      expect(value.filler).toHaveLength(FILLER);
    }
  });
});
