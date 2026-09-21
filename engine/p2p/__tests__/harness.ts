import { Buffer } from 'node:buffer';

import {
  MatchmakingError,
  type Admission,
  type Json,
  type Match,
  type Ticket,
} from '@joinbankroll/sdk/matchmaking';
import {
  ChargeMismatchError,
  chargeMismatch,
  HSUSD_MINT,
  type ConfirmedCharge,
  type ManagedReference,
  type PayRecipient,
  type PaymentSigner,
  type Timer,
} from '@joinbankroll/sdk/server';
import { PreconditionFailed, type StoreBackend } from '@joinbankroll/sdk/store';
import type {
  AppEvent,
  BankrollWebhookHandlers,
  ReferenceConfirmed,
} from '@joinbankroll/sdk/webhooks';

import type { BankrollPrimitives, PayoutEvidence, PreparedPayout } from '../bankroll';
import type { PaymentRequest, Treasury } from '../types';

type Hook = (context: Record<string, unknown>) => void | Promise<void>;

export interface HarnessReference extends ManagedReference {
  origin: string;
  meta: Record<string, Json>;
  status: 'pending' | 'confirmed' | 'expired';
  signature: string | null;
}

export interface HarnessTimer extends Timer {
  origin: string;
  meta: Record<string, Json>;
  dueAt: number;
  fired: boolean;
}

export interface HarnessTransfer {
  signature: string;
  attemptId: string;
  reference: string;
  payee: string;
  recipients: PayRecipient[];
  memo: string;
}

export interface HarnessSend extends PreparedPayout {
  payee: string;
  returnedSignature: string | null;
}

const copy = <T>(value: T): T => structuredClone(value);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** All state is local to this fixture. No SDK mock, environment, network or real store. */
export function createHarness(options: { mode?: 'signed' | 'hosted'; now?: number } = {}) {
  const mode = options.mode ?? 'signed';
  let time = options.now ?? 1_800_000_000_000;
  let serial = 0;
  const next = (prefix: string) => `${prefix}-${++serial}`;
  const now = () => time;
  const origin = () => 'https://engine.example.test';
  const terms = { payee: 'treasury', creatorWallet: 'treasury', mint: HSUSD_MINT };

  const documents = new Map<string, string>();
  const hooks = new Map<string, Hook[]>();
  const events: AppEvent[] = [];
  const deliveries: AppEvent[] = [];
  const references = new Map<string, HarnessReference>();
  const timers = new Map<string, HarnessTimer>();
  const tickets = new Map<string, Ticket<Json>>();
  const matches = new Map<string, Match<Json>>();
  const queuePolicies = new Map<string, string>();
  const charges = new Map<string, ConfirmedCharge>();
  const sends: HarnessSend[] = [];
  const transfers: HarnessTransfer[] = [];
  const preparations = new Map<string, Parameters<BankrollPrimitives['prepare']>[0]>();
  const attempts = new Map<string, PreparedPayout>();
  const evidence = new Map<string, PayoutEvidence['status']>();
  const stats = { reads: 0, writes: 0, creates: 0, lists: 0, casFailures: 0 };
  let webhook: BankrollWebhookHandlers | null = null;

  async function hit(point: string, context: Record<string, unknown>) {
    const queue = hooks.get(point);
    const hook = queue?.shift();
    if (queue?.length === 0) hooks.delete(point);
    await hook?.(context);
  }

  function on(point: string, hook: Hook) {
    const queue = hooks.get(point) ?? [];
    queue.push(hook);
    hooks.set(point, queue);
  }

  function failNext(point: string, error = new Error(`Interrupted at ${point}`)) {
    on(point, () => {
      throw error;
    });
  }

  const store: StoreBackend = {
    async readJson<T>(path: string) {
      stats.reads++;
      const json = documents.get(path);
      // Identical contents deliberately have identical etags, like the SDK fs store.
      return json === undefined ? null : { value: JSON.parse(json) as T, etag: json };
    },
    async writeJson(path, value, ifMatch) {
      stats.writes++;
      await hit('store.write.before', { path, value: copy(value), ifMatch });
      if (ifMatch !== undefined && documents.get(path) !== ifMatch) {
        stats.casFailures++;
        throw new PreconditionFailed(path);
      }
      documents.set(path, JSON.stringify(value));
      await hit('store.write.after', { path, value: copy(value), ifMatch });
    },
    async createIfAbsent(path, value) {
      stats.creates++;
      await hit('store.create.before', { path, value: copy(value) });
      if (documents.has(path)) return false;
      documents.set(path, JSON.stringify(value));
      await hit('store.create.after', { path, value: copy(value) });
      return true;
    },
    async list<T>(prefix: string, settings: { limit?: number; cursor?: string } = {}) {
      stats.lists++;
      const { cursor, limit = 25 } = settings;
      const keys = [...documents.keys()]
        .filter((key) => key.startsWith(prefix) && (cursor === undefined || key > cursor))
        .sort();
      const page = keys.slice(0, limit);
      const items = page.map((key) => JSON.parse(documents.get(key)!) as T);
      return {
        items,
        ...(keys.length > page.length && page.length ? { cursor: page.at(-1)! } : {}),
      };
    },
  };

  function confirmed(
    reference: HarnessReference,
    signature: string,
    slot: number,
  ): ReferenceConfirmed {
    const event: ReferenceConfirmed = {
      type: 'reference.confirmed',
      reference: reference.reference,
      meta: copy(reference.meta),
      signature,
      slot,
    };
    // A managed reference reports its first observation, never both terminal events.
    if (reference.status === 'pending') {
      reference.status = 'confirmed';
      reference.signature = signature;
      events.push(event);
    }
    return copy(event);
  }

  function expireReference(reference: HarnessReference) {
    if (reference.status !== 'pending') return;
    reference.status = 'expired';
    events.push({
      type: 'reference.expired',
      reference: reference.reference,
      meta: copy(reference.meta),
      expiredAt: reference.expiresAt,
    });
  }

  function currentTicket(id: string): Ticket<Json> | undefined {
    const ticket = tickets.get(id);
    if (ticket?.state === 'waiting') {
      const expiresAt = ticket.admission.input.expiresAt;
      if (expiresAt !== undefined && expiresAt <= time) {
        const cancelled: Ticket<Json> = {
          id,
          state: 'cancelled',
          admission: ticket.admission,
          reason: 'expired',
          cancelledAt: expiresAt,
        };
        tickets.set(id, cancelled);
        return cancelled;
      }
    }
    return ticket;
  }

  const primitives: BankrollPrimitives = {
    async reference(input) {
      const reference: HarnessReference = {
        reference: next('reference'),
        expiresAt: new Date(time + (input.expiresInSeconds ?? 420) * 1_000).toISOString(),
        origin: input.origin,
        meta: copy(input.meta),
        status: 'pending',
        signature: null,
      };
      references.set(reference.reference, reference);
      await hit('reference.after', { ...copy(reference) });
      return { reference: reference.reference, expiresAt: reference.expiresAt };
    },
    async timer(input) {
      const minutes = Math.max(1, Math.ceil((input.dueAt - time) / 60_000));
      if (!Number.isFinite(minutes)) throw new Error('Invalid timer deadline');
      const timer: HarnessTimer = {
        ...copy(input),
        id: next('timer'),
        at: new Date(time + minutes * 60_000).toISOString(),
        fired: false,
      };
      timers.set(timer.id, timer);
      await hit('timer.after', { ...copy(timer) });
      return { id: timer.id, at: timer.at };
    },
    matchmaking() {
      return {
        async createTicket(raw) {
          const input = copy(raw);
          await hit('createTicket.before', { input });
          const existing = currentTicket(input.id);
          let result: Ticket<Json>;
          if (existing) {
            if (existing.admission && canonical(existing.admission.input) !== canonical(input))
              throw new MatchmakingError('ticket_conflict', 'Changed ticket input');
            result = existing;
          } else {
            const policy = canonical(input.queue);
            if (queuePolicies.has(input.queue.key) && queuePolicies.get(input.queue.key) !== policy)
              throw new MatchmakingError('queue_conflict', 'Changed queue policy');
            queuePolicies.set(input.queue.key, policy);
            const admission: Admission<Json> = {
              input,
              createdAt: time,
              payload: copy(input.payload),
            };
            if (input.expiresAt !== undefined && input.expiresAt <= time) {
              result = {
                id: input.id,
                state: 'cancelled',
                admission,
                reason: 'expired',
                cancelledAt: input.expiresAt,
              };
            } else {
              const waiting = [...tickets.keys()]
                .map(currentTicket)
                .filter(
                  (ticket): ticket is Extract<Ticket<Json>, { state: 'waiting' }> =>
                    ticket?.state === 'waiting',
                )
                .filter((ticket) => {
                  const other = ticket.admission.input;
                  if (other.player === input.player || other.queue.key !== input.queue.key)
                    return false;
                  if (input.rating === undefined && other.rating === undefined) return true;
                  if (
                    input.rating === undefined ||
                    other.rating === undefined ||
                    !input.queue.rating
                  )
                    return false;
                  const policy = input.queue.rating;
                  const tolerance = Math.min(
                    policy.max ?? Infinity,
                    policy.initial +
                      (policy.widenPerSecond * Math.max(0, time - ticket.admission.createdAt)) /
                        1_000,
                  );
                  return Math.abs(input.rating - other.rating) <= tolerance;
                })
                .sort((a, b) => a.admission.createdAt - b.admission.createdAt)[0];
              if (waiting) {
                admission.payload = copy(waiting.admission.payload);
                const match: Match<Json> = {
                  id: next('match'),
                  queue: input.queue.key,
                  matchedAt: time,
                  payload: copy(admission.payload),
                  tickets: [copy(waiting.admission), admission],
                };
                matches.set(match.id, copy(match));
                tickets.set(waiting.id, { ...waiting, state: 'matched', match: copy(match) });
                result = { id: input.id, state: 'matched', admission, match };
              } else result = { id: input.id, state: 'waiting', admission };
            }
            tickets.set(input.id, copy(result));
          }
          await hit('createTicket.after', { input, ticket: copy(result) });
          return copy(result);
        },
        async listTickets(query = {}) {
          const found = [...tickets.keys()]
            .map(currentTicket)
            .filter((ticket): ticket is Ticket<Json> => Boolean(ticket))
            .filter(
              (ticket) =>
                (query.id === undefined || ticket.id === query.id) &&
                (query.player === undefined || ticket.admission?.input.player === query.player),
            );
          const offset = Number(query.cursor ?? 0);
          const page = found.slice(offset, offset + 25);
          return {
            tickets: copy(page),
            nextCursor: offset + page.length < found.length ? String(offset + page.length) : null,
          };
        },
        async cancelTicket(id) {
          await hit('cancelTicket.before', { id });
          const current = currentTicket(id);
          const cancelled: Extract<Ticket<Json>, { state: 'matched' | 'cancelled' }> = current &&
          current.state !== 'waiting'
            ? current
            : {
                id,
                state: 'cancelled',
                admission: current?.admission ?? null,
                reason: 'requested',
                cancelledAt: time,
              };
          tickets.set(id, copy(cancelled));
          await hit('cancelTicket.after', { id, ticket: copy(cancelled) });
          return copy(cancelled);
        },
      };
    },
    async charge(signature, expected) {
      const receipt = charges.get(signature);
      if (!receipt) throw new Error('Unknown charge receipt');
      const field = chargeMismatch(receipt, expected);
      if (field) throw new ChargeMismatchError(copy(receipt), field);
      return copy(receipt);
    },
    async prepare(input) {
      const existing = attempts.get(input.id);
      if (existing) {
        if (canonical(preparations.get(input.id)) !== canonical(input))
          throw new Error('Changed payout preparation');
        return copy(existing);
      }
      const attempt: PreparedPayout = {
        id: input.id,
        reference: input.reference,
        transaction: Buffer.from(JSON.stringify(input)).toString('base64'),
        mode,
        signature: mode === 'signed' ? `signed-${input.id}` : null,
        lastValidBlockHeight: mode === 'signed' ? 1_000 : null,
      };
      preparations.set(input.id, copy(input));
      attempts.set(input.id, copy(attempt));
      await hit('prepare.after', { attempt: copy(attempt), input: copy(input) });
      return attempt;
    },
    async send(attempt, payee) {
      const send: HarnessSend = { ...copy(attempt), payee, returnedSignature: null };
      sends.push(send);
      await hit('send.before', { attempt: copy(attempt), payee });
      const prepared = preparations.get(attempt.id);
      const original = attempts.get(attempt.id);
      if (
        !prepared ||
        !original ||
        prepared.payee !== payee ||
        original.transaction !== attempt.transaction
      )
        throw new Error('Invalid payout attempt');
      if (attempt.mode === 'signed' && evidence.get(attempt.id) === 'retryable')
        throw new Error('Transaction cannot execute');
      const signature =
        attempt.mode === 'signed' ? original.signature! : next(`hosted-${attempt.id}`);
      if (!transfers.some((transfer) => transfer.signature === signature)) {
        transfers.push({
          signature,
          attemptId: attempt.id,
          reference: attempt.reference,
          payee,
          recipients: copy(prepared.recipients),
          memo: prepared.memo,
        });
      }
      send.returnedSignature = signature;
      const reference = references.get(attempt.reference);
      if (!reference) throw new Error('Unknown payout reference');
      confirmed(reference, signature, ++serial);
      await hit('send.after', { attempt: copy(attempt), payee, signature });
      return signature;
    },
    async reconcile(attempt) {
      await hit('reconcile.before', { attempt: copy(attempt) });
      const status = evidence.get(attempt.id);
      const transfer = transfers.find((item) => item.attemptId === attempt.id);
      const result: PayoutEvidence =
        status === 'retryable' || status === 'unresolved'
          ? { status }
          : status === 'paid' || transfer
            ? {
                status: 'paid',
                signature: transfer?.signature ?? attempt.signature ?? `external-${attempt.id}`,
              }
            : { status: 'unresolved' };
      await hit('reconcile.after', { attempt: copy(attempt), evidence: copy(result) });
      return result;
    },
    async verify(attempt, signature) {
      if (attempt.signature !== null && attempt.signature !== signature)
        throw new Error('Payout receipt does not match the recorded signature');
      const transfer = transfers.find((item) => item.signature === signature);
      const prepared = preparations.get(attempt.id);
      if (
        !transfer ||
        !prepared ||
        transfer.reference !== attempt.reference ||
        transfer.payee !== prepared.payee ||
        canonical(transfer.recipients) !== canonical(prepared.recipients) ||
        transfer.memo !== prepared.memo
      )
        throw new Error('Payout receipt does not match the prepared transfer');
    },
  };

  // The engine uses the primitive substitutions; these catch accidental adapter bypasses.
  const signer: PaymentSigner = {
    address: terms.payee,
    async sendTransaction() {
      throw new Error('Tests must use the substituted Bankroll primitives');
    },
    ...(mode === 'signed'
      ? {
          signTransaction() {
            throw new Error('Tests must use the substituted Bankroll primitives');
          },
        }
      : {}),
  };
  const treasury: Treasury = { terms: () => copy(terms), signer: () => signer };

  function pay(
    payment: PaymentRequest | null,
    wallet: string,
    overrides: Partial<ConfirmedCharge> = {},
  ): ReferenceConfirmed {
    if (!payment) throw new Error('Round has no payment request');
    const reference = references.get(payment.reference);
    if (!reference) throw new Error('Unknown pay-in reference');
    const signature = overrides.signature ?? next('charge');
    const receipt = charges.get(signature) ?? {
      signature,
      payer: wallet,
      payee: terms.payee,
      mint: terms.mint,
      amountCents: payment.amountCents,
      memo: payment.memo,
      slot: ++serial,
      ...copy(overrides),
    };
    charges.set(signature, copy(receipt));
    return confirmed(reference, signature, receipt.slot);
  }

  async function deliver(event: AppEvent): Promise<void> {
    if (!webhook) throw new Error('Connect the engine webhook before delivery');
    deliveries.push(copy(event));
    if (event.type === 'reference.confirmed') await webhook.onConfirmed(copy(event));
    else if (event.type === 'reference.expired') await webhook.onExpired(copy(event));
    else {
      if (!webhook.onFired) throw new Error('The engine has no timer handler');
      await webhook.onFired(copy(event));
    }
  }

  async function flush(limit = 100): Promise<void> {
    for (let delivered = 0; events.length > 0; delivered++) {
      if (delivered >= limit) throw new Error('Webhook flush exceeded its delivery limit');
      const event = events[0];
      // A failed delivery stays at the front for a later flush, with original metadata.
      await deliver(event);
      events.shift();
    }
  }

  function advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0)
      throw new Error('Clock must advance by a finite nonnegative interval');
    time += ms;
    const due = [
      ...[...timers.values()]
        .filter((timer) => !timer.fired && Date.parse(timer.at) <= time)
        .map((timer) => ({
          at: Date.parse(timer.at),
          run() {
            timer.fired = true;
            events.push({
              type: 'timer.fired' as const,
              id: timer.id,
              meta: copy(timer.meta),
              at: timer.at,
            });
          },
        })),
      ...[...references.values()]
        .filter(
          (reference) => reference.status === 'pending' && Date.parse(reference.expiresAt) <= time,
        )
        .map((reference) => ({
          at: Date.parse(reference.expiresAt),
          run() {
            expireReference(reference);
          },
        })),
    ].sort((a, b) => a.at - b.at);
    for (const event of due) event.run();
  }

  function expireAttempt(id: string): void {
    const attempt = attempts.get(id);
    if (!attempt) throw new Error('Unknown payout attempt');
    const reference = references.get(attempt.reference);
    if (!reference) throw new Error('Unknown payout reference');
    // Observation expiry deliberately says nothing about execution evidence.
    expireReference(reference);
  }

  return {
    store,
    primitives,
    treasury,
    origin,
    now,
    stats,
    events,
    deliveries,
    timers,
    references,
    tickets,
    matches,
    sends,
    transfers,
    attempts,
    charges,
    connect(handlers: BankrollWebhookHandlers) {
      webhook = handlers;
    },
    pay,
    flush,
    advance,
    deliver,
    on,
    failNext,
    expireAttempt,
    setEvidence(id: string, status: PayoutEvidence['status']) {
      if (!attempts.has(id)) throw new Error('Unknown payout attempt');
      evidence.set(id, status);
    },
  };
}
