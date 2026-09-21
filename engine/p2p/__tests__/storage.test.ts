import {
  DocumentNotFound,
  PreconditionFailed,
  type StoreBackend,
  TooContended,
} from '@joinbankroll/sdk/store';
import { describe, expect, it, vi } from 'vitest';

import { createPersistence, type Document } from '../storage';

interface Counter extends Document {
  count: number;
  alarm: { token: string; dueAt: number } | null;
}

const path = 'engine/rounds/one.json';
const initial: Counter = { revision: 0, count: 0, alarm: null };

function fixture() {
  const documents = new Map<string, string>();
  let writes = 0;
  let beforeWrite: (() => Promise<void>) | null = null;
  const backend: StoreBackend = {
    async readJson<T>(key: string) {
      const json = documents.get(key);
      // The filesystem store also hashes contents, so identical writes cannot fence.
      return json === undefined ? null : { value: JSON.parse(json) as T, etag: json };
    },
    async writeJson(key, value, ifMatch) {
      writes++;
      const handler = beforeWrite;
      beforeWrite = null;
      await handler?.();
      if (ifMatch !== undefined && documents.get(key) !== ifMatch)
        throw new PreconditionFailed(key);
      documents.set(key, JSON.stringify(value));
    },
    async createIfAbsent(key, value) {
      if (documents.has(key)) return false;
      documents.set(key, JSON.stringify(value));
      return true;
    },
    async list<T>() {
      return { items: [] as T[] };
    },
  };
  return {
    persistence: createPersistence(backend),
    backend,
    get writes() {
      return writes;
    },
    onWrite(handler: () => Promise<void>) {
      beforeWrite = handler;
    },
  };
}

describe('engine persistence', () => {
  it('creates revision-zero shells once and reads without changing them', async () => {
    const test = fixture();
    expect(await test.persistence.read(path)).toBeNull();
    expect(await test.persistence.create(path, initial)).toEqual(initial);
    expect(await test.persistence.create(path, { ...initial, count: 99 })).toEqual(initial);
    expect((await test.persistence.read(path))?.value).toEqual(initial);
    expect(test.writes).toBe(0);
    await expect(test.persistence.create(path, { ...initial, revision: 1 })).rejects.toThrow(
      'revision zero',
    );
  });

  it('preserves alarms on ordinary writes and performs no write for an identity no-op', async () => {
    const test = fixture();
    const alarm = { token: 'business-deadline', dueAt: 20_000 };
    await test.persistence.create(path, { ...initial, alarm });
    const changed = await test.persistence.change<Counter>(path, (current) => ({
      ...current,
      count: 1,
    }));
    expect(changed).toEqual({ revision: 1, count: 1, alarm });
    expect(await test.persistence.change<Counter>(path, (current) => current)).toEqual(changed);
    expect(test.writes).toBe(1);
  });

  it('retries a losing change against the new state rather than dropping concurrent work', async () => {
    const test = fixture();
    await test.persistence.create(path, initial);
    await Promise.all([
      test.persistence.change<Counter>(path, (current) => ({
        ...current,
        count: current.count + 1,
      })),
      test.persistence.change<Counter>(path, (current) => ({
        ...current,
        count: current.count + 1,
      })),
    ]);
    expect((await test.persistence.read(path))?.value).toEqual({
      ...initial,
      count: 2,
      revision: 2,
    });
    expect(test.writes).toBe(3);
  });

  it('rejects a prepared transition after any revision change without running its callback', async () => {
    const test = fixture();
    await test.persistence.create(path, initial);
    await test.persistence.change<Counter>(path, (current) => ({ ...current, count: 1 }));
    const install = vi.fn((current: Counter) => ({ ...current, count: 99 }));
    expect(await test.persistence.conditional(path, 0, install)).toBeNull();
    expect(install).not.toHaveBeenCalled();
    expect(test.writes).toBe(1);
  });

  it('never automatically retries a prepared transition after losing its exact-etag write', async () => {
    const test = fixture();
    await test.persistence.create(path, initial);
    test.onWrite(async () => {
      await test.persistence.change<Counter>(path, (current) => ({ ...current, count: 1 }));
    });
    const install = vi.fn((current: Counter) => ({ ...current, count: 99 }));
    expect(await test.persistence.conditional(path, 0, install)).toBeNull();
    expect(install).toHaveBeenCalledTimes(1);
    expect((await test.persistence.read(path))?.value).toEqual({
      ...initial,
      count: 1,
      revision: 1,
    });
  });

  it('fences an early delivery so a paused preparation cannot later install its event', async () => {
    const test = fixture();
    await test.persistence.create(path, initial);
    const before = (await test.persistence.read<Counter>(path))!;
    await test.persistence.fence(path, before.value.revision);
    const after = (await test.persistence.read<Counter>(path))!;
    expect(after.value).toEqual({ ...initial, revision: 1 });
    expect(after.etag).not.toBe(before.etag);
    expect(
      await test.persistence.conditional<Counter>(path, before.value.revision, (current) => ({
        ...current,
        alarm: { token: 'already-delivered', dueAt: 20_000 },
      })),
    ).toBeNull();
    await test.persistence.fence(path, before.value.revision);
    expect(test.writes).toBe(1);
  });

  it('leaves a concurrently installed event intact when its write beats the fence', async () => {
    const test = fixture();
    await test.persistence.create(path, initial);
    const alarm = { token: 'installed-event', dueAt: 20_000 };
    test.onWrite(async () => {
      expect(
        await test.persistence.conditional<Counter>(path, 0, (current) => ({ ...current, alarm })),
      ).not.toBeNull();
    });
    await test.persistence.fence(path, 0);
    // The event handler rereads identity and processes this installed event.
    expect((await test.persistence.read<Counter>(path))?.value).toEqual({
      ...initial,
      alarm,
      revision: 1,
    });
  });

  it('changes the content etag even when only the revision changes', async () => {
    const test = fixture();
    await test.persistence.create(path, initial);
    const before = (await test.persistence.read(path))!;
    const after = await test.persistence.conditional<Counter>(path, 0, (current) => ({
      ...current,
    }));
    expect(after).toEqual({ ...initial, revision: 1 });
    expect((await test.persistence.read(path))?.etag).not.toBe(before.etag);
  });

  it('propagates missing documents and future preparation revisions', async () => {
    const test = fixture();
    await expect(
      test.persistence.change(path, (current) => ({ ...current })),
    ).rejects.toBeInstanceOf(DocumentNotFound);
    await expect(
      test.persistence.conditional(path, 0, (current) => ({ ...current })),
    ).rejects.toBeInstanceOf(DocumentNotFound);
    await expect(test.persistence.fence(path, 0)).rejects.toBeInstanceOf(DocumentNotFound);
    await test.persistence.create(path, initial);
    await expect(test.persistence.fence(path, 1)).rejects.toThrow('future document revision');
    expect(test.writes).toBe(0);
  });

  it('bounds retries and propagates non-conflict store failures', async () => {
    const test = fixture();
    await test.persistence.create(path, initial);
    const write = vi
      .spyOn(test.backend, 'writeJson')
      .mockRejectedValue(new PreconditionFailed(path));
    await expect(
      test.persistence.change(path, (current) => ({ ...current })),
    ).rejects.toBeInstanceOf(TooContended);
    expect(write).toHaveBeenCalledTimes(20);
    write.mockRejectedValue(new Error('Store offline'));
    await expect(test.persistence.change(path, (current) => ({ ...current }))).rejects.toThrow(
      'Store offline',
    );
  });
});
