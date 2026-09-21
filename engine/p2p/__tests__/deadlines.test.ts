import { describe, expect, it } from 'vitest';

import { createDeadlines, type DeadlineDocument } from '../deadlines';
import type { EventMeta } from '../model';
import { createPersistence } from '../storage';
import { createHarness } from './harness';

interface Round extends DeadlineDocument {
  count: number;
}

const namespace = 'deadline-test';
const path = `${namespace}/round.json`;

async function fixture() {
  const harness = createHarness();
  const store = createPersistence(harness.store);
  const deadlines = createDeadlines({ store, primitives: harness.primitives, namespace });
  await store.create<Round>(path, { revision: 0, origin: harness.origin(), timers: {}, count: 0 });
  return { harness, store, deadlines, dueAt: harness.now() + 120_000 };
}

describe('business deadlines', () => {
  it('makes ordinary writes and identity no-ops without registering timers', async () => {
    const { harness, deadlines } = await fixture();
    const changed = await deadlines.update<Round>(path, (current) => ({
      value: { ...current, count: 1 },
    }));
    expect(changed.count).toBe(1);
    expect(changed.revision).toBe(1);
    expect(harness.timers.size).toBe(0);
    const writes = harness.stats.writes;
    expect(await deadlines.update<Round>(path, (current) => ({ value: current }))).toEqual(changed);
    expect(harness.stats.writes).toBe(writes);
  });

  it('preserves timer identity across unrelated writes and explicit unchanged deadlines', async () => {
    const { harness, deadlines, dueAt } = await fixture();
    const armed = await deadlines.update<Round>(path, (current) => ({
      value: current,
      deadlines: { game: dueAt },
    }));
    const slot = armed.timers.game;
    expect(slot?.dueAt).toBe(dueAt);
    const timer = [...harness.timers.values()][0];
    expect(timer.meta).toEqual({
      engine: namespace,
      kind: 'deadline',
      path,
      token: slot!.token,
      baseRevision: 0,
      purpose: 'game',
    });
    const changed = await deadlines.update<Round>(path, (current) => ({
      value: { ...current, count: 1 },
    }));
    expect(changed.timers.game).toEqual(slot);
    const unchanged = await deadlines.update<Round>(path, (current) => ({
      value: current,
      deadlines: { game: dueAt },
    }));
    expect(unchanged).toEqual(changed);
    expect(harness.timers.size).toBe(1);
  });

  it('replaces only changed deadlines and removes slots without creating a new timer', async () => {
    const { harness, deadlines, dueAt } = await fixture();
    const armed = await deadlines.update<Round>(path, (current) => ({
      value: current,
      deadlines: { game: dueAt, queue: dueAt + 60_000 },
    }));
    const changed = await deadlines.update<Round>(path, (current) => ({
      value: current,
      deadlines: { game: dueAt + 30_000 },
    }));
    expect(changed.timers.queue).toEqual(armed.timers.queue);
    expect(changed.timers.game?.token).not.toBe(armed.timers.game?.token);
    expect(changed.timers.game?.dueAt).toBe(dueAt + 30_000);
    expect(harness.timers.size).toBe(3);
    const cleared = await deadlines.update<Round>(path, (current) => ({
      value: current,
      deadlines: { game: null },
    }));
    expect(cleared.timers.game).toBeUndefined();
    expect(cleared.timers.queue).toEqual(armed.timers.queue);
    expect(harness.timers.size).toBe(3);
  });

  it('does not commit a state when its deadline registration fails', async () => {
    const { harness, store, deadlines, dueAt } = await fixture();
    harness.failNext('timer.after', new Error('Lost registration response'));
    await expect(
      deadlines.update<Round>(path, (current) => ({
        value: { ...current, count: 1 },
        deadlines: { game: dueAt },
      })),
    ).rejects.toThrow('Lost registration response');
    expect((await store.required<Round>(path)).value).toEqual({
      revision: 0,
      origin: harness.origin(),
      timers: {},
      count: 0,
    });
  });

  it('reprepares with a fresh token when early delivery fences the pending registration', async () => {
    const { harness, store, deadlines, dueAt } = await fixture();
    harness.on('timer.after', async ({ meta }) => {
      const event = meta as unknown as EventMeta;
      await store.fence(event.path, event.baseRevision);
    });
    const armed = await deadlines.update<Round>(path, (current) => ({
      value: { ...current, count: 1 },
      deadlines: { game: dueAt },
    }));
    const registrations = [...harness.timers.values()];
    expect(registrations).toHaveLength(2);
    expect(registrations.map((timer) => timer.meta.baseRevision)).toEqual([0, 1]);
    expect(registrations[0].meta.token).not.toBe(registrations[1].meta.token);
    expect(armed.timers.game?.id).toBe(registrations[1].id);
    expect(armed.revision).toBe(2);
    expect(armed.count).toBe(1);
  });

  it('recomputes after a concurrent change without attaching a prepared timer to a newer revision', async () => {
    const { harness, store, deadlines, dueAt } = await fixture();
    harness.on('timer.after', async () => {
      await store.change<Round>(path, (current) => ({ ...current, count: current.count + 1 }));
    });
    const armed = await deadlines.update<Round>(path, (current) => ({
      value: { ...current, count: current.count + 1 },
      deadlines: { game: dueAt },
    }));
    expect(armed.count).toBe(2);
    expect(armed.revision).toBe(2);
    const registrations = [...harness.timers.values()];
    expect(registrations.map((timer) => timer.meta.baseRevision)).toEqual([0, 1]);
    expect(armed.timers.game?.id).toBe(registrations[1].id);
  });

  it('retries an exact-etag collision with a fresh timer rather than silently overwriting', async () => {
    const { harness, store, deadlines, dueAt } = await fixture();
    harness.on('store.write.before', async () => {
      await store.change<Round>(path, (current) => ({ ...current, count: current.count + 1 }));
    });
    const armed = await deadlines.update<Round>(path, (current) => ({
      value: { ...current, count: current.count + 1 },
      deadlines: { game: dueAt },
    }));
    expect(armed.count).toBe(2);
    expect(harness.stats.casFailures).toBe(1);
    expect(harness.timers.size).toBe(2);
    expect(armed.timers.game?.id).toBe([...harness.timers.values()][1].id);
  });
});
