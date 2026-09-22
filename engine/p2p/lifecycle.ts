import { randomUUID } from 'node:crypto';

import type { Json, Match, Ticket } from '@joinbankroll/sdk/matchmaking';
import { mockEnabled, MOCK_OPPONENT } from '@joinbankroll/sdk/mock';
import {
  ChargeMismatchError,
  type ConfirmedCharge,
  type PayRecipient,
} from '@joinbankroll/sdk/server';
import type {
  AppEvent,
  BankrollWebhookHandlers,
  ReferenceConfirmed,
} from '@joinbankroll/sdk/webhooks';

import { createBankrollPrimitives } from './bankroll';
import { createDeadlines } from './deadlines';
import type { EventMeta, MatchDocument, Round, Purpose } from './model';
import { createPayments } from './payments';
import { createPersistence } from './storage';
import {
  EngineError,
  type Actor,
  type EngineOptions,
  type CommandResult,
  type GameContext,
  type Progress,
  type OperatorInspection,
  type RoundSnapshot as RoundView,
} from './types';
import { canonical, copy, equal, hash, identifier, termsFor, validateGame } from './util';

/** A server-only engine. The caller supplies verified identities, never client wallet claims. */
export function createLifecycle<C, S, A, R, V>(options: EngineOptions<C, S, A, R, V>) {
  type Entry = Round<C, S, R>;
  const game = options.game;
  const versions = new Map<number, typeof game>();
  for (const definition of [...(options.previousVersions ?? []), game]) {
    validateGame(definition);
    if (definition.id !== game.id || versions.has(definition.version))
      throw new EngineError('invalid_game_configuration');
    versions.set(definition.version, definition);
  }
  const namespace = options.namespace ?? `p2p/${game.id}`;
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(namespace))
    throw new EngineError('invalid_namespace');
  const now = options.now ?? Date.now;
  const primitives =
    options.primitives ??
    createBankrollPrimitives({ payoutSigner: (id) => options.treasury.signer(id), now });
  const store = createPersistence(options.store);
  const deadlines = createDeadlines({ store, primitives, namespace });
  const payments = createPayments({
    store,
    primitives,
    namespace,
    now,
    watchSeconds: (id) => (options.treasury.signer(id).signTransaction ? 900 : 86_400),
  });
  const offers = options.offers ?? { default: {} };
  const roundPrefix = (wallet: string) => `${namespace}/rounds/${hash(identifier(wallet))}/`;
  const roundPath = (wallet: string, id: string) => {
    if (!/^\d{16}-[a-f0-9]{32}$/.test(id)) throw new EngineError('invalid_round_id');
    return `${roundPrefix(wallet)}${id}.json`;
  };
  const matchPath = (id: string) => `${namespace}/matches/${hash(id)}.json`;
  const required = async <D extends { revision: number }>(path: string): Promise<D> => {
    const found = await store.read<D>(path);
    if (!found) throw new EngineError('not_found');
    return found.value;
  };
  const definition = (entry: Entry) => {
    const found = versions.get(entry.version);
    if (!found) throw new EngineError('game_version_unavailable');
    return found;
  };
  const context = (entry: Entry, at: number): GameContext<C> => ({
    challenge: copy(entry.challenge),
    startedAt: entry.play!.startedAt,
    endsAt: entry.play!.endsAt,
    closesAt: entry.play!.closesAt,
    now: at,
  });
  const matched = (entry: Entry) => (entry.ticket?.state === 'matched' ? entry.ticket.match : null);
  const startDeadline = (entry: Entry) => {
    const match = matched(entry);
    return match ? match.matchedAt + entry.terms.startWindowMs : null;
  };
  const synthetic = (wallet: string) => mockEnabled() && wallet === MOCK_OPPONENT;

  function progress(
    entry: Entry,
    value: Progress<S, R>,
    at: number,
    reason: 'played' | 'timeout',
  ): Entry {
    if (!entry.play || !value || (value.status !== 'finished' && value.status !== 'running'))
      throw new Error('Invalid game transition');
    const state = copy(value.state);
    if (value.status === 'finished')
      return {
        ...entry,
        play: { ...entry.play, state },
        finish: { reason, result: copy(value.result) },
      };
    const due = value.nextDeadlineAt ?? entry.play.closesAt;
    if (!Number.isSafeInteger(due) || due <= at || due > entry.play.closesAt)
      throw new Error('Invalid game deadline');
    return { ...entry, play: { ...entry.play, state, nextDeadlineAt: due } };
  }

  async function advance(path: string, at: number): Promise<Entry> {
    return deadlines.update<Entry>(path, (entry) => {
      if (entry.issue || entry.finish || entry.cancelled) return { value: entry };
      if (!entry.play) {
        const due = startDeadline(entry);
        return {
          value:
            due !== null && at >= due
              ? {
                  ...entry,
                  sequence: entry.sequence + 1,
                  finish: { reason: 'forfeit', result: null },
                }
              : entry,
        };
      }
      if (entry.play.nextDeadlineAt > at) return { value: entry };
      let next = entry;
      try {
        const rules = definition(entry);
        for (let count = 0; !next.finish && next.play!.nextDeadlineAt <= at; count++) {
          if (count === 64) throw new Error('Too many game deadlines');
          const due = next.play!.nextDeadlineAt;
          next = progress(
            next,
            rules.step(copy(next.play!.state), { type: 'deadline' }, context(next, due)),
            due,
            'timeout',
          );
        }
      } catch (error) {
        if (error instanceof EngineError && error.code === 'game_version_unavailable') throw error;
        return { value: { ...entry, issue: 'game_fault' } };
      }
      return {
        value: { ...next, sequence: entry.sequence + 1 },
        ...(!next.finish ? { deadlines: { game: next.play!.nextDeadlineAt } } : {}),
      };
    });
  }

  async function adopt(path: string, ticket: Ticket<Json>): Promise<Entry> {
    return deadlines.update<Entry>(path, (entry) => {
      if (entry.ticket?.state === 'matched') {
        if (ticket.state === 'matched' && !equal(entry.ticket.match, ticket.match))
          throw new Error('Match changed');
        return { value: entry };
      }
      if (entry.ticket?.state === 'cancelled') {
        if (ticket.state === 'matched') throw new Error('Cancelled ticket became matched');
        return { value: entry };
      }
      if (ticket.id !== entry.id) throw new Error('Wrong matchmaking ticket');
      if (ticket.admission && !equal(ticket.admission.input, entry.ticketInput))
        throw new Error('Admission terms changed');
      let challenge = entry.challenge;
      let issue = entry.issue;
      if (ticket.admission) {
        try {
          challenge = copy(definition(entry).parseChallenge(ticket.admission.payload));
          if (entry.play && !equal(challenge, entry.challenge))
            throw new Error('Playing challenge changed');
        } catch (error) {
          if (error instanceof EngineError && error.code === 'game_version_unavailable')
            throw error;
          issue = 'invalid_match_challenge';
          challenge = entry.challenge;
        }
      }
      const next = {
        ...entry,
        challenge,
        ticket,
        issue,
        cancelRequested: ticket.state === 'matched' ? false : entry.cancelRequested,
        cancelled: ticket.state === 'cancelled',
      };
      const due =
        ticket.state === 'matched' && !entry.play && !entry.finish
          ? { 'no-show': ticket.match.matchedAt + entry.terms.startWindowMs }
          : undefined;
      return equal(entry, next) ? { value: entry } : { value: next, deadlines: due };
    });
  }

  async function refund(path: string): Promise<void> {
    for (let count = 0; count < 20; count++) {
      const entry = await required<Entry>(path);
      if (entry.payout) {
        await payments.send(path);
        return;
      }
      const receipt = entry.receipt;
      if (!receipt || !entry.cancelled) return;
      if (
        receipt.payee !== entry.terms.payee ||
        receipt.mint !== entry.terms.mint ||
        !Number.isSafeInteger(receipt.amountCents) ||
        receipt.amountCents <= 0
      ) {
        await store.change<Entry>(path, (current) =>
          current.issue === 'payment_cannot_refund'
            ? current
            : { ...current, issue: 'payment_cannot_refund' },
        );
        return;
      }
      const installed = await payments.install<Entry>(
        path,
        entry.revision,
        {
          id: `refund:${entry.id}`,
          payee: entry.terms.payee,
          recipients: [{ to: receipt.payer, amountCents: receipt.amountCents }],
          memo: `p2p:refund:${entry.id}`,
        },
        (current, payout) => ({ ...current, payout }),
      );
      if (installed) {
        await payments.send(path);
        return;
      }
    }
    throw new Error('Refund preparation contended');
  }

  async function clearTimers(path: string, purposes: Purpose[]) {
    await deadlines.update<Entry>(path, (entry) => ({
      value: entry,
      deadlines: Object.fromEntries(purposes.map((purpose) => [purpose, null])),
    }));
  }

  async function settle(path: string, entries: Array<Entry | null>): Promise<void> {
    for (let count = 0; count < 20; count++) {
      const document = await required<MatchDocument>(path);
      if (document.payout) {
        await payments.send(path);
        return;
      }
      if (document.issue) return;
      let winner: string | null = null;
      const [a, b] = entries;
      const forfeitA = !a || a.finish!.reason === 'forfeit';
      const forfeitB = !b || b.finish!.reason === 'forfeit';
      try {
        if (forfeitA !== forfeitB) winner = forfeitA ? b!.wallet : a!.wallet;
        else if (!forfeitA) {
          const result = definition(a!).compare(copy(a!.finish!.result!), copy(b!.finish!.result!));
          if (result !== 'a' && result !== 'b' && result !== 'tie')
            throw new Error('Invalid comparison');
          winner = result === 'a' ? a!.wallet : result === 'b' ? b!.wallet : null;
        }
      } catch (error) {
        if (error instanceof EngineError && error.code === 'game_version_unavailable') throw error;
        await store.change<MatchDocument>(path, (current) => ({ ...current, issue: 'game_fault' }));
        return;
      }
      const recipients: PayRecipient[] = entries
        .filter((entry): entry is Entry => entry !== null)
        .map((entry) => ({
          to: entry.wallet,
          amountCents:
            winner === null
              ? document.terms.entryCents
              : winner === entry.wallet
                ? document.terms.prizeCents
                : 0,
        }));
      if (document.terms.creatorWallet !== document.terms.payee) {
        const amount = winner === null ? 0 : document.terms.creatorFeeCents;
        const recipient = recipients.find((item) => item.to === document.terms.creatorWallet);
        if (recipient) recipient.amountCents += amount;
        else recipients.push({ to: document.terms.creatorWallet, amountCents: amount });
      }
      const installed = await payments.install<MatchDocument>(
        path,
        document.revision,
        {
          id: `match:${document.id}`,
          payee: document.terms.payee,
          recipients,
          memo: `p2p:match:${document.id}`,
        },
        (current, payout) => ({
          ...current,
          outcome: { kind: winner === null ? 'tie' : 'win', winner },
          payout,
        }),
      );
      if (installed) {
        await payments.send(path);
        return;
      }
    }
    throw new Error('Match settlement contended');
  }

  async function processMatch(match: Match<Json>, source: Entry, at: number): Promise<void> {
    if (
      match.queue !== source.terms.queue ||
      match.tickets.length !== 2 ||
      match.tickets[0].input.player === match.tickets[1].input.player ||
      !match.tickets.some(
        (admission) => admission.input.id === source.id && admission.input.player === source.wallet,
      )
    )
      throw new Error('Invalid matchmaking result');
    const path = matchPath(match.id);
    const document = await store.create<MatchDocument>(path, {
      schema: 1,
      kind: 'match',
      revision: 0,
      id: match.id,
      origin: source.origin,
      gameId: source.gameId,
      version: source.version,
      match,
      terms: source.terms,
      outcome: null,
      payout: null,
      issue: null,
      timers: {},
    });
    if (!equal(document.match, match) || !equal(document.terms, source.terms))
      throw new Error('Match terms changed');
    const entries: Array<Entry | null> = [];
    for (const admission of match.tickets) {
      if (synthetic(admission.input.player)) {
        entries.push(null);
        continue;
      }
      const playerPath = roundPath(admission.input.player, admission.input.id);
      const player = await required<Entry>(playerPath);
      if (!player.receipt || player.paymentRejected || player.terms.queue !== source.terms.queue)
        throw new Error('Unfunded or incompatible opponent');
      await adopt(playerPath, { id: player.id, state: 'matched', admission, match });
      entries.push(await advance(playerPath, at));
    }
    const mockDue = match.matchedAt + source.terms.startWindowMs;
    const hasSynthetic = entries.some((entry) => entry === null);
    if (hasSynthetic && at < mockDue && !document.payout) {
      await deadlines.update<MatchDocument>(path, (current) => ({
        value: current,
        deadlines: { 'no-show': mockDue },
      }));
    }
    if (entries.some((entry) => entry?.issue)) {
      await store.change<MatchDocument>(path, (current) =>
        current.issue ? current : { ...current, issue: 'player_needs_attention' },
      );
    } else if (entries.every((entry) => (entry ? Boolean(entry.finish) : at >= mockDue))) {
      await settle(path, entries);
    }
    const current = await required<MatchDocument>(path);
    for (const entry of entries) {
      if (!entry) continue;
      // A watched payout, explicit fault, or the other player's real deadline
      // owns the next consequence before a finished player's timer is retired.
      const peerOwnsDeadline =
        entries.some(
          (peer) =>
            peer &&
            peer.id !== entry.id &&
            !peer.finish &&
            Object.keys(peer.timers).some((key) => key !== 'queue'),
        ) ||
        (hasSynthetic && at < mockDue);
      const remove: Purpose[] =
        current.payout || current.issue || (entry.finish && peerOwnsDeadline)
          ? ['queue', 'no-show', 'game']
          : entry.play
            ? ['queue', 'no-show']
            : ['queue'];
      await clearTimers(roundPath(entry.wallet, entry.id), remove);
    }
    if (current.payout || current.issue)
      await deadlines.update<MatchDocument>(path, (value) => ({
        value,
        deadlines: { 'no-show': null },
      }));
  }

  async function resume(path: string, at: number): Promise<Entry> {
    let entry = await required<Entry>(path);
    if (!entry.receipt) return entry;
    const knownMatch = matched(entry);
    if (knownMatch) {
      await processMatch(knownMatch, entry, at);
      return required<Entry>(path);
    }
    const shouldCancel =
      entry.cancelRequested ||
      entry.cancelled ||
      entry.paymentRejected ||
      (entry.queueExpiresAt !== null && at >= entry.queueExpiresAt);
    const matchmaking = primitives.matchmaking(entry.origin);
    if (shouldCancel) {
      entry = await adopt(path, await matchmaking.cancelTicket(entry.id));
      if (matched(entry)) await processMatch(matched(entry)!, entry, at);
      else {
        await refund(path);
        await clearTimers(path, ['queue', 'no-show', 'game']);
      }
    } else if (entry.ticketInput) {
      entry = await adopt(path, await matchmaking.createTicket(entry.ticketInput));
      if (matched(entry)) await processMatch(matched(entry)!, entry, at);
      else if (entry.cancelled) {
        await refund(path);
        await clearTimers(path, ['queue', 'no-show', 'game']);
      } else {
        entry = await advance(path, at);
        if (entry.finish || entry.issue) await clearTimers(path, ['game', 'no-show']);
      }
    }
    return required<Entry>(path);
  }

  async function acceptPayment(path: string, event: ReferenceConfirmed): Promise<void> {
    let entry = await required<Entry>(path);
    if (entry.receipt && entry.receipt.signature !== event.signature)
      throw new Error('Pay-in reference changed its receipt');
    if (!entry.receipt) {
      if (!entry.payment) throw new Error('Pay-in is not installed');
      let receipt: ConfirmedCharge;
      let rejected = false;
      try {
        receipt = await primitives.charge(event.signature, {
          payer: entry.wallet,
          payee: entry.terms.payee,
          mint: entry.terms.mint,
          amountCents: entry.terms.entryCents,
          memo: entry.payment.memo,
        });
      } catch (error) {
        if (!(error instanceof ChargeMismatchError)) throw error;
        receipt = error.charge;
        rejected = true;
      }
      const claim = await store.create(
        `${'p2p-receipts'}/${hash(entry.terms.payee)}/${hash(receipt.signature)}.json`,
        {
          revision: 0,
          owner: path,
          receipt,
        },
      );
      if (claim.owner !== path) {
        await store.change<Entry>(path, (current) => ({
          ...current,
          cancelled: true,
          issue: 'payment_already_used',
        }));
        return;
      }
      const acceptedAt = now();
      entry = await deadlines.update<Entry>(path, (current) => {
        if (current.receipt) return { value: current };
        const queueExpiresAt = acceptedAt + current.terms.queueWindowMs;
        const cancelled = current.cancelled || rejected;
        return {
          value: {
            ...current,
            receipt,
            paymentRejected: rejected,
            cancelled,
            payment: { ...current.payment!, signature: receipt.signature },
            queueExpiresAt,
            ticketInput: {
              id: current.id,
              player: current.wallet,
              queue: { key: current.terms.queue, size: 2 },
              payload: copy(current.challenge) as Json,
              expiresAt: queueExpiresAt,
            },
            issue: rejected ? 'payment_mismatch' : current.issue,
          },
          deadlines: cancelled ? {} : { queue: queueExpiresAt },
        };
      });
    }
    await resume(path, now());
  }

  function eventMeta(event: AppEvent): EventMeta | null {
    const value = event.meta;
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.engine !== namespace)
      return null;
    if (
      typeof value.path !== 'string' ||
      (!value.path.startsWith(`${namespace}/rounds/`) &&
        !value.path.startsWith(`${namespace}/matches/`)) ||
      value.path.includes('..') ||
      typeof value.token !== 'string' ||
      !Number.isSafeInteger(value.baseRevision) ||
      Number(value.baseRevision) < 0 ||
      !['payin', 'payout', 'deadline'].includes(String(value.kind))
    )
      throw new Error('Invalid engine event metadata');
    if (value.kind === 'deadline' && !['queue', 'no-show', 'game'].includes(String(value.purpose)))
      throw new Error('Invalid deadline purpose');
    return value as unknown as EventMeta;
  }

  async function onEvent(event: AppEvent): Promise<void> {
    const meta = eventMeta(event);
    if (!meta) return;
    type Owned = Entry | MatchDocument;
    let document = await required<Owned>(meta.path);
    const active = (value: Owned) => {
      if (meta.kind === 'deadline')
        return (
          event.type === 'timer.fired' &&
          value.timers[meta.purpose!]?.token === meta.token &&
          value.timers[meta.purpose!]?.id === event.id
        );
      if (event.type === 'timer.fired') return false;
      if (meta.kind === 'payin')
        return (
          value.kind === 'round' &&
          value.payment?.reference === event.reference &&
          value.payment.idempotencyKey === meta.token
        );
      return (
        value.payout?.attempt.id === meta.token &&
        value.payout.attempt.reference === event.reference
      );
    };
    if (!active(document)) {
      await store.fence(meta.path, meta.baseRevision);
      document = await required<Owned>(meta.path);
      if (!active(document)) return;
    }
    if (meta.kind === 'payout') {
      if (event.type === 'reference.confirmed')
        await payments.confirm(meta.path, event.reference, event.signature);
      else if (event.type === 'reference.expired')
        await payments.expire(meta.path, event.reference);
      return;
    }
    if (document.kind === 'match') {
      const admission = document.match.tickets.find((item) => !synthetic(item.input.player));
      if (!admission) throw new Error('Match has no real player');
      await processMatch(
        document.match,
        await required<Entry>(roundPath(admission.input.player, admission.input.id)),
        now(),
      );
      return;
    }
    if (meta.kind === 'payin' && event.type === 'reference.confirmed')
      await acceptPayment(meta.path, event);
    else if (meta.kind === 'payin' && event.type === 'reference.expired') {
      await store.change<Entry>(meta.path, (current) =>
        current.receipt || current.cancelled ? current : { ...current, cancelled: true },
      );
      await resume(meta.path, now());
    } else if (event.type === 'timer.fired') {
      const slot = document.timers[meta.purpose!]!;
      if (now() < slot.dueAt) throw new Error('Deadline delivered before its business cutoff');
      await advance(meta.path, now());
      await resume(meta.path, now());
    }
  }

  async function view(entry: Entry): Promise<RoundView<V, R>> {
    const match = matched(entry);
    const settlement = match
      ? ((await store.read<MatchDocument>(matchPath(match.id)))?.value ?? null)
      : null;
    const payout = entry.payout ?? settlement?.payout;
    let issue = entry.issue ?? settlement?.issue ?? payout?.issue ?? null;
    let gameView: V | null = null;
    if (entry.play) {
      try {
        gameView = copy(definition(entry).view(copy(entry.play.state), context(entry, now())));
      } catch (error) {
        if (error instanceof EngineError && error.code === 'game_version_unavailable') throw error;
        issue ??= 'game_view_fault';
      }
    }
    const at = now();
    const startAt = startDeadline(entry);
    const live = Boolean(
      entry.receipt &&
      entry.ticket &&
      entry.ticket.state !== 'cancelled' &&
      !entry.paymentRejected &&
      !entry.cancelled &&
      !entry.cancelRequested &&
      !issue &&
      (match || (entry.queueExpiresAt !== null && at < entry.queueExpiresAt)),
    );
    const payment =
      entry.payment &&
      !entry.receipt &&
      !entry.cancelled &&
      !issue &&
      Date.parse(entry.payment.expiresAt) > at
        ? {
            amountCents: entry.payment.amountCents,
            reference: entry.payment.reference,
            memo: entry.payment.memo,
            idempotencyKey: entry.payment.idempotencyKey,
            expiresAt: entry.payment.expiresAt,
          }
        : null;
    return {
      id: entry.id,
      gameId: entry.gameId,
      version: entry.version,
      createdAt: entry.createdAt,
      status:
        issue || payout?.status === 'needs_attention'
          ? 'needs_attention'
          : entry.cancelled
            ? 'cancelled'
            : entry.finish
              ? entry.finish.reason === 'forfeit'
                ? 'forfeited'
                : 'finished'
              : entry.play
                ? 'playing'
                : entry.receipt
                  ? entry.ticket
                    ? 'ready'
                    : 'initializing'
                  : entry.payment
                    ? 'awaiting_payment'
                    : 'initializing',
      sequence: entry.sequence,
      entryCents: entry.terms.entryCents,
      payment,
      paid: Boolean(entry.receipt && !entry.paymentRejected),
      opponent: match ? 'matched' : entry.cancelled ? 'cancelled' : 'waiting',
      game: gameView,
      result: entry.finish?.result ?? null,
      deadlines: {
        queue: entry.queueExpiresAt,
        start: startAt,
        play: entry.play?.endsAt ?? null,
        submission: entry.play?.closesAt ?? null,
      },
      allowed: {
        start: live && !entry.play && !entry.finish && (startAt === null || at < startAt),
        act: live && Boolean(entry.play && !entry.finish && at < entry.play.closesAt),
      },
      outcome: settlement?.outcome
        ? {
            kind:
              settlement.outcome.kind === 'tie'
                ? 'tie'
                : settlement.outcome.winner === entry.wallet
                  ? 'win'
                  : 'loss',
            amountCents:
              settlement.outcome.kind === 'tie'
                ? entry.terms.entryCents
                : settlement.outcome.winner === entry.wallet
                  ? entry.terms.prizeCents
                  : 0,
          }
        : null,
      payout: payout
        ? {
            kind: entry.payout ? 'refund' : 'prize',
            status: payout.status,
            signature: payout.signature,
          }
        : null,
      issue,
    };
  }

  const commandKey = (commandId: string) => hash(identifier(commandId));
  function duplicate(entry: Entry, commandId: string, fingerprint: string) {
    const receipt = entry.commands[commandKey(commandId)];
    if (receipt && receipt.fingerprint !== fingerprint) throw new EngineError('command_conflict');
    return receipt;
  }
  const acknowledge = (
    entry: Entry,
    commandId: string,
    fingerprint: string,
    at: number,
  ): Entry => ({
    ...entry,
    sequence: entry.sequence + 1,
    commands: {
      ...entry.commands,
      [commandKey(commandId)]: { fingerprint, acceptedAt: at, sequence: entry.sequence + 1 },
    },
  });
  async function response(path: string, commandId: string): Promise<CommandResult<V, R>> {
    const entry = await required<Entry>(path);
    return {
      command: { id: commandId, sequence: entry.commands[commandKey(commandId)].sequence },
      round: await view(entry),
    };
  }

  async function enter(
    actor: Actor,
    input: { commandId: string; offerId?: string },
  ): Promise<CommandResult<V, R>> {
    identifier(actor.wallet);
    const key = commandKey(input.commandId);
    const offerId = input.offerId ?? 'default';
    identifier(offerId);
    const fingerprint = canonical({ type: 'enter', offerId });
    const intentPath = `${namespace}/commands/${hash(actor.wallet)}/${key}.json`;
    type Intent = { revision: number; fingerprint: string; round: Entry };
    let intent = (await store.read<Intent>(intentPath))?.value;
    if (!intent) {
      if (!Object.hasOwn(offers, offerId)) throw new EngineError('unknown_offer');
      const at = now();
      const id = `${String(1_000_000_000_000_000 - at).padStart(16, '0')}-${randomUUID().replaceAll('-', '')}`;
      const challenge = copy(game.parseChallenge(game.challenge(randomUUID())));
      const origin = await options.origin();
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin)
        throw new EngineError('invalid_origin');
      const round: Entry = {
        schema: 1,
        kind: 'round',
        revision: 0,
        id,
        wallet: actor.wallet,
        origin,
        createdAt: at,
        gameId: game.id,
        version: game.version,
        terms: termsFor(
          game.id,
          game.version,
          game.durationMs,
          game.submissionGraceMs ?? 0,
          offerId,
          offers[offerId],
          options.treasury.terms(),
        ),
        challenge,
        payment: null,
        receipt: null,
        paymentRejected: false,
        queueExpiresAt: null,
        ticketInput: null,
        ticket: null,
        cancelRequested: false,
        cancelled: false,
        play: null,
        finish: null,
        sequence: 0,
        commands: { [key]: { fingerprint, acceptedAt: at, sequence: 0 } },
        timers: {},
        payout: null,
        issue: null,
      };
      intent = await store.create<Intent>(intentPath, { revision: 0, fingerprint, round });
    }
    if (intent.fingerprint !== fingerprint) throw new EngineError('command_conflict');
    const path = roundPath(actor.wallet, intent.round.id);
    await store.create(path, intent.round);
    for (let count = 0; count < 20; count++) {
      const entry = await required<Entry>(path);
      if (entry.payment || entry.cancelled) {
        await resume(path, now());
        return response(path, input.commandId);
      }
      const token = randomUUID();
      const reference = await primitives.reference({
        origin: entry.origin,
        meta: { engine: namespace, kind: 'payin', path, token, baseRevision: entry.revision },
      });
      if (Date.parse(reference.expiresAt) <= now())
        throw new Error('Entry reference expired during preparation');
      const installed = await store.conditional<Entry>(path, entry.revision, (current) => ({
        ...current,
        payment: {
          amountCents: current.terms.entryCents,
          ...reference,
          memo: `p2p:entry:${current.id}`,
          idempotencyKey: token,
          signature: null,
        },
      }));
      if (installed) return response(path, input.commandId);
    }
    throw new Error('Entry preparation contended');
  }

  type Command = { roundId: string; commandId: string };
  async function run(
    actor: Actor,
    input: Command,
    operation: 'start' | 'act',
    action?: { sequence: number; value: unknown },
  ): Promise<CommandResult<V, R>> {
    commandKey(input.commandId);
    const path = roundPath(actor.wallet, input.roundId);
    const at = now();
    const fingerprint = canonical({
      type: operation,
      ...(action ? { sequence: action.sequence, action: action.value } : {}),
    });
    const before = await required<Entry>(path);
    if (duplicate(before, input.commandId, fingerprint)) {
      await resume(path, at);
      return response(path, input.commandId);
    }
    await resume(path, at);
    await deadlines.update<Entry>(path, (entry) => {
      if (duplicate(entry, input.commandId, fingerprint)) return { value: entry };
      if (entry.issue) throw new EngineError('needs_attention');
      if (!entry.receipt || entry.paymentRejected) throw new EngineError('payment_required');
      if (entry.cancelled || entry.cancelRequested || entry.finish)
        throw new EngineError('round_closed');
      if (
        operation === 'act' &&
        (!Number.isSafeInteger(action!.sequence) || entry.sequence !== action!.sequence)
      )
        throw new EngineError('stale_sequence');
      let next = entry;
      try {
        const rules = definition(entry);
        if (operation === 'start') {
          const due = startDeadline(entry);
          if (due !== null && at >= due) throw new EngineError('start_window_closed');
          if (!entry.play) {
            next = {
              ...entry,
              play: {
                state: null as S,
                startedAt: at,
                endsAt: at + rules.durationMs,
                closesAt: at + rules.durationMs + (rules.submissionGraceMs ?? 0),
                nextDeadlineAt: 0,
              },
            };
            next = progress(next, rules.start(context(next, at)), at, 'played');
          }
        } else {
          if (!entry.play) throw new EngineError('not_started');
          if (at >= entry.play.closesAt) throw new EngineError('round_closed');
          const parsed = rules.parseAction(copy(action!.value));
          next = progress(
            entry,
            rules.step(
              copy(entry.play.state),
              { type: 'action', action: parsed },
              context(entry, at),
            ),
            at,
            'played',
          );
        }
      } catch (error) {
        if (
          error instanceof EngineError &&
          [
            'invalid_action',
            'game_version_unavailable',
            'start_window_closed',
            'not_started',
            'round_closed',
          ].includes(error.code)
        )
          throw error;
        return {
          value: acknowledge({ ...entry, issue: 'game_fault' }, input.commandId, fingerprint, at),
        };
      }
      return {
        value: acknowledge(next, input.commandId, fingerprint, at),
        ...(!next.finish && next.play ? { deadlines: { game: next.play.nextDeadlineAt } } : {}),
      };
    });
    await resume(path, at);
    return response(path, input.commandId);
  }

  async function history(actor: Actor, input: { cursor?: string; limit?: number } = {}) {
    const prefix = roundPrefix(actor.wallet);
    const limit = input.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new EngineError('invalid_limit');
    let cursor: string | undefined;
    if (input.cursor) {
      try {
        if (input.cursor.length > 8_192) throw new Error('Cursor too large');
        const decoded = JSON.parse(Buffer.from(input.cursor, 'base64url').toString());
        if (decoded.owner !== prefix || typeof decoded.cursor !== 'string')
          throw new Error('Wrong cursor owner');
        cursor = decoded.cursor;
      } catch {
        throw new EngineError('invalid_cursor');
      }
    }
    const page = await options.store.list<Entry>(prefix, { limit, ...(cursor ? { cursor } : {}) });
    return {
      rounds: await Promise.all(page.items.map(view)),
      cursor: page.cursor
        ? Buffer.from(JSON.stringify({ owner: prefix, cursor: page.cursor })).toString('base64url')
        : null,
    };
  }

  async function inspect(
    actor: Actor,
    input: { wallet: string; roundId: string },
  ): Promise<Omit<OperatorInspection<V, R>, 'round'> & { round: RoundView<V, R> }> {
    if (!(await options.authorizeOperator?.(actor))) throw new EngineError('forbidden');
    const entry = await required<Entry>(roundPath(input.wallet, input.roundId));
    const match = matched(entry);
    const settlement = match ? (await store.read<MatchDocument>(matchPath(match.id)))?.value : null;
    const payout = entry.payout ?? settlement?.payout;
    return {
      round: await view(entry),
      receipt: copy(entry.receipt),
      matchId: match?.id ?? null,
      payment: payout
        ? {
            id: payout.id,
            payee: payout.payee,
            recipients: copy(payout.recipients),
            status: payout.status,
            signature: payout.signature,
            issue: payout.issue,
            attempts: [...payout.retired, payout.attempt].map((attempt) => ({
              id: attempt.id,
              reference: attempt.reference,
              mode: attempt.mode,
              signature: attempt.signature,
              expiresAt: attempt.expiresAt,
              lastValidBlockHeight: attempt.lastValidBlockHeight,
              claimed: attempt.claim !== null,
            })),
          }
        : null,
    };
  }

  async function reconcile(actor: Actor, input: { wallet: string; roundId: string }) {
    if (!(await options.authorizeOperator?.(actor))) throw new EngineError('forbidden');
    const path = roundPath(input.wallet, input.roundId);
    const entry = await required<Entry>(path);
    await payments.reconcile(
      entry.payout ? path : matched(entry) ? matchPath(matched(entry)!.id) : path,
    );
    return view(await required<Entry>(path));
  }

  const webhook: BankrollWebhookHandlers = {
    onConfirmed: onEvent,
    onExpired: onEvent,
    onFired: onEvent,
  };
  return {
    enter,
    start: (actor: Actor, input: Command) => run(actor, input, 'start'),
    act: (actor: Actor, input: Command & { sequence: number; action: unknown }) =>
      run(actor, input, 'act', { sequence: input.sequence, value: input.action }),
    resumeExisting: async (actor: Actor, roundId: string) =>
      view(await resume(roundPath(actor.wallet, roundId), now())),
    get: async (actor: Actor, roundId: string) =>
      view(await required<Entry>(roundPath(actor.wallet, roundId))),
    history,
    inspect,
    reconcile,
    webhook,
  };
}
