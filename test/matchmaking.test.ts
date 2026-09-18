import { randomUUID } from 'node:crypto';

import {
  createMatchmaking,
  MatchmakingError,
  type Ticket,
  type TicketInput,
} from '@joinbankroll/sdk/matchmaking';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { acceptedConditions as accepted } from '@/lib/p2p/matching';
import type { GameHooks } from '@/lib/p2p/types';

type Conditions = { seed: number; version: number };
const hooks: GameHooks<null, Conditions> = {
  conditions: {
    key: 'shared-conditions-test:1',
    validate(payload) {
      const value = payload as Partial<Conditions> | null;
      if (!value || !Number.isSafeInteger(value.seed) || value.version !== 1)
        throw new MatchmakingError('invalid_response', 'Unsupported round conditions');
      return { seed: value.seed!, version: 1 };
    },
  },
  terminal: () => null,
  outcome: () => ({ kind: 'tie', winner: null }),
};
const acceptedConditions = (ticket: Ticket<Conditions>) => accepted(hooks, ticket);

beforeEach(() => {
  vi.stubEnv('BANKROLL_MOCK', '1');
  // Keep the SDK's automatic stand-in from joining between these two players.
  vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function input(queue: string, seed: number): TicketInput<Conditions> {
  return {
    id: randomUUID(),
    player: randomUUID(),
    queue: { key: queue, size: 2 },
    payload: { seed, version: 1 },
  };
}

describe('shared round conditions', () => {
  it('gives matched players identical accepted conditions despite different proposed seeds', async () => {
    const matchmaking = createMatchmaking<Conditions>({ origin: 'https://test.example' });
    const queue = randomUUID();
    const firstInput = input(queue, 42);
    const secondInput = input(queue, 999);
    const first = await matchmaking.createTicket(firstInput);
    const second = await matchmaking.createTicket(secondInput);

    expect(first.state).toBe('waiting');
    expect(second.state).toBe('matched');
    expect(acceptedConditions(first).seed).toBe(42);
    expect(acceptedConditions(second).seed).toBe(42);
    expect(acceptedConditions(first)).toEqual(acceptedConditions(second));

    // Retry the original proposal, not the adopted seed. Changing the proposal
    // under this ticket id would be a conflicting entry to the SDK.
    const retry = await matchmaking.createTicket(secondInput);
    expect(acceptedConditions(retry)).toEqual(acceptedConditions(second));
    expect(secondInput.payload.seed).toBe(999);
    const recovered = await matchmaking.listTickets({
      id: firstInput.id,
      player: firstInput.player,
    });
    expect(acceptedConditions(recovered.tickets[0])).toEqual(acceptedConditions(second));
  });

  it('rejects incompatible rules and cancelled entries before starting play', async () => {
    const matchmaking = createMatchmaking<Conditions>({ origin: 'https://test.example' });
    const proposal = input(randomUUID(), 42);
    proposal.payload.version++;
    const ticket = await matchmaking.createTicket(proposal);
    expect(() => acceptedConditions(ticket)).toThrow('Unsupported round conditions');
    const cancelled = await matchmaking.cancelTicket(proposal.id);
    expect(() => acceptedConditions(cancelled)).toThrow('A cancelled ticket cannot start');
  });
});
