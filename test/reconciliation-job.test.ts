import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';

import { storeDirectory } from '@joinbankroll/sdk/store/fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { GameError } from '@/lib/game-error';
import { LEASE_MS, runReconciliation, type ReconciliationState } from '@/lib/p2p/worker';
import { storeBackend } from '@/lib/store';

// Financial transitions are tested against the real store/SDK queue in p2p.test.ts.
// Here only the per-entry work is controlled to exercise scheduler failures.
const reconcileEntry = vi.fn<(wallet: string, id: string, origin: string) => Promise<void>>();

const roots: string[] = [];
const origin = 'https://p2p.test';
let indexPrefix: string;
let statePath: string;
let now: number;
const run = (limit = 25) =>
  runReconciliation(storeBackend(), reconcileEntry, origin, { indexPrefix, statePath, limit });
const state = async () => (await storeBackend().readJson<ReconciliationState>(statePath))!.value;
async function add(id: string) {
  await storeBackend().createIfAbsent(`${indexPrefix}${id}.json`, { wallet: 'test-player', id });
}

beforeAll(() => {
  expect(process.env.NODE_ENV).toBe('test');
  expect(['fs', 'blob']).toContain(process.env.STORE);
  if (process.env.STORE === 'fs') expect(storeDirectory()).toBe('bankroll/test');
  else {
    expect(process.env.DANGEROUS_BLOB_TOKEN).toBeTruthy();
    expect(process.env.BLOB_READ_WRITE_TOKEN).toBe(process.env.DANGEROUS_BLOB_TOKEN);
  }
});
beforeEach(() => {
  const root = `reconciliation-tests/${randomUUID()}`;
  roots.push(root);
  indexPrefix = `${root}/entries/`;
  statePath = `${root}/worker.json`;
  now = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.mocked(reconcileEntry).mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  if (process.env.STORE === 'fs' && storeDirectory() === 'bankroll/test')
    await Promise.all(
      roots.map((root) => rm(`${storeDirectory()}/${root}`, { recursive: true, force: true })),
    );
});

describe('durable reconciliation cursor', () => {
  it('resumes past the first page and wraps for entries inserted ahead of its cursor', async () => {
    for (const id of ['20', '30', '40']) await add(id);
    expect(await run(2)).toMatchObject({ processed: 2, completedPass: false });
    await add('10');
    expect(await run(2)).toMatchObject({ processed: 1, completedPass: true });
    expect(await run(2)).toMatchObject({ processed: 2, completedPass: false });
    expect(vi.mocked(reconcileEntry).mock.calls.map((call) => call[1])).toEqual([
      '20',
      '30',
      '40',
      '10',
      '20',
    ]);
  });

  it('continues after one entry fails and retries that entry on the next pass', async () => {
    await add('10');
    await add('20');
    vi.mocked(reconcileEntry).mockRejectedValueOnce(
      new Error('secret reference must not be logged'),
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await run()).toMatchObject({ failed: 1, processed: 2, completedPass: true });
    expect(log).toHaveBeenCalledWith('reconciliation_failed', {
      id: '10',
      code: 'unexpected_error',
    });
    expect(await state()).toMatchObject({ owner: null, leaseUntil: 0, lastRun: { failed: 1 } });
    expect(await run()).toMatchObject({ failed: 0, processed: 2 });
    expect(vi.mocked(reconcileEntry).mock.calls.map((call) => call[1])).toEqual([
      '10',
      '20',
      '10',
      '20',
    ]);
  });

  it('does not remove a pointer while its game creation is still in flight', async () => {
    await add('10');
    vi.mocked(reconcileEntry).mockRejectedValueOnce(new GameError('game_not_found', 404));
    expect(await run()).toMatchObject({ missing: 1, failed: 0 });
    expect(await storeBackend().readJson(`${indexPrefix}10.json`)).not.toBeNull();
    expect(await run()).toMatchObject({ processed: 1, missing: 0 });
  });

  it('allows only one overlapping invocation to own the cursor', async () => {
    await add('10');
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(reconcileEntry).mockImplementationOnce(async () => {
      entered();
      await blocked;
    });
    const first = run();
    await started;
    expect(await run()).toEqual({ skipped: true });
    release();
    expect(await first).toMatchObject({ processed: 1, failed: 0 });
    expect(reconcileEntry).toHaveBeenCalledTimes(1);
  });

  it('recovers an abandoned lease and preserves progress written before a killed item', async () => {
    await add('10');
    await add('20');
    const backend = storeBackend();
    const write = backend.writeJson.bind(backend);
    vi.spyOn(backend, 'writeJson').mockImplementation(async (path, value, etag) => {
      if (path === statePath && (value as ReconciliationState).owner === null)
        throw new Error('process ended before release');
      return write(path, value, etag);
    });
    await expect(run(1)).rejects.toThrow('process ended before release');
    const crashed = await state();
    expect(crashed.cursor).toBeTruthy();
    expect(crashed.owner).not.toBeNull();
    expect(await run()).toEqual({ skipped: true });
    vi.mocked(backend.writeJson).mockRestore();
    now += LEASE_MS + 1;
    expect(await run()).toMatchObject({ processed: 1, completedPass: true });
    expect(vi.mocked(reconcileEntry).mock.calls.map((call) => call[1])).toEqual(['10', '20']);
    expect(await run(1)).toMatchObject({ processed: 1 });
    expect(vi.mocked(reconcileEntry).mock.calls.at(-1)?.[1]).toBe('10');
  });

  it('does not let an expired owner overwrite its replacement checkpoint', async () => {
    await add('10');
    await add('20');
    vi.mocked(reconcileEntry).mockImplementationOnce(async () => {
      const stored = (await storeBackend().readJson<ReconciliationState>(statePath))!;
      await storeBackend().writeJson(
        statePath,
        {
          ...stored.value,
          owner: 'replacement',
          leaseUntil: now + LEASE_MS,
        },
        stored.etag,
      );
    });
    await expect(run()).rejects.toThrow('reconciliation_lease_lost');
    expect((await state()).owner).toBe('replacement');
    expect(reconcileEntry).toHaveBeenCalledTimes(1);
  });
});
