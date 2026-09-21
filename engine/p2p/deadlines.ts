import { randomUUID } from 'node:crypto';

import { TooContended } from '@joinbankroll/sdk/store';

import type { BankrollPrimitives } from './bankroll';
import type { Purpose, TimerSlot } from './model';
import type { createPersistence } from './storage';

export interface DeadlineDocument {
  revision: number;
  origin: string;
  timers: Partial<Record<Purpose, TimerSlot>>;
}

export interface DeadlineDecision<D> {
  value: D;
  deadlines?: Partial<Record<Purpose, number | null>>;
}

const PURPOSES: Purpose[] = ['queue', 'no-show', 'game'];
const ATTEMPTS = 20;

/** Register only new business deadlines, then install against their exact preparation. */
export function createDeadlines({
  store,
  primitives,
  namespace,
}: {
  store: ReturnType<typeof createPersistence>;
  primitives: Pick<BankrollPrimitives, 'timer'>;
  namespace: string;
}) {
  async function update<D extends DeadlineDocument>(
    path: string,
    decide: (current: D) => DeadlineDecision<D>,
  ): Promise<D> {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const { value: current } = await store.required<D>(path);
      const decision = decide(current);
      if (decision.value.origin !== current.origin)
        throw new Error('Document origin cannot change');
      let timers = current.timers;
      for (const purpose of PURPOSES) {
        const dueAt = decision.deadlines?.[purpose];
        if (dueAt === undefined) continue;
        const existing = timers[purpose];
        if (dueAt === null) {
          if (existing) {
            timers = { ...timers };
            delete timers[purpose];
          }
          continue;
        }
        if (!Number.isFinite(dueAt)) throw new Error('Invalid deadline');
        if (existing?.dueAt === dueAt) continue;
        const token = randomUUID();
        const registered = await primitives.timer({
          origin: current.origin,
          dueAt,
          meta: {
            engine: namespace,
            kind: 'deadline',
            path,
            token,
            baseRevision: current.revision,
            purpose,
          },
        });
        if (!registered.id || !Number.isFinite(Date.parse(registered.at)))
          throw new Error('Invalid timer registration');
        timers = { ...timers, [purpose]: { ...registered, token, dueAt } };
      }
      if (decision.value === current && timers === current.timers) return current;
      const next = { ...decision.value, timers };
      const installed = await store.conditional<D>(path, current.revision, () => next);
      if (installed) return installed;
      // All registrations from a losing preparation are abandoned. A new
      // snapshot gets fresh tokens; preserved slots need no new registration.
    }
    throw new TooContended(path, ATTEMPTS);
  }

  return { update };
}
