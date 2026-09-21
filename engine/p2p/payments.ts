import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { PayRecipient } from '@joinbankroll/sdk/server';

import { PayoutReceiptMismatch, type BankrollPrimitives } from './bankroll';
import type { Attempt, Payout } from './model';
import type { createPersistence } from './storage';

export interface PaymentSpec {
  id: string;
  payee: string;
  recipients: PayRecipient[];
  memo: string;
}

export interface PaymentDocument {
  revision: number;
  origin: string;
  payout: Payout | null;
}

/** Payment ownership is one document; references supply the next legitimate delivery. */
export function createPayments({
  store,
  primitives,
  namespace,
  now,
  watchSeconds,
}: {
  store: ReturnType<typeof createPersistence>;
  primitives: BankrollPrimitives;
  namespace: string;
  now: () => number;
  watchSeconds: (attemptId: string) => number;
}) {
  function sameTerms(payout: Payout, spec: PaymentSpec) {
    return (
      payout.id === spec.id &&
      payout.payee === spec.payee &&
      payout.memo === spec.memo &&
      isDeepStrictEqual(payout.recipients, spec.recipients)
    );
  }

  async function prepare(
    path: string,
    document: PaymentDocument,
    spec: PaymentSpec,
  ): Promise<Attempt> {
    const id = randomUUID();
    const reference = await primitives.reference({
      origin: document.origin,
      meta: { engine: namespace, kind: 'payout', path, token: id, baseRevision: document.revision },
      expiresInSeconds: watchSeconds(id),
    });
    const built = await primitives.prepare({
      id,
      reference: reference.reference,
      payee: spec.payee,
      recipients: spec.recipients,
      memo: spec.memo,
    });
    if (built.id !== id || built.reference !== reference.reference)
      throw new Error('Prepared payout does not match its registered attempt');
    if (!Number.isFinite(Date.parse(reference.expiresAt)))
      throw new Error('Payout reference has an invalid expiry');
    return { ...built, expiresAt: reference.expiresAt, claim: null };
  }

  async function install<D extends PaymentDocument>(
    path: string,
    baseRevision: number,
    spec: PaymentSpec,
    commit: (current: D, payout: Payout) => D,
  ): Promise<D | null> {
    const stored = await store.required<D>(path);
    if (stored.value.revision !== baseRevision) return null;
    if (stored.value.payout) {
      if (!sameTerms(stored.value.payout, spec))
        throw new Error('An existing payout has different terms');
      return stored.value;
    }
    const fixed = { ...spec, recipients: spec.recipients.map((recipient) => ({ ...recipient })) };
    const attempt = await prepare(path, stored.value, fixed);
    // The event's revision fence closes the pause-after-check race. This check
    // also avoids knowingly installing a watch whose observation already ended.
    if (Date.parse(attempt.expiresAt) <= now()) return null;
    const payout: Payout = {
      ...fixed,
      status: 'pending',
      attempt,
      retired: [],
      signature: null,
      issue: null,
    };
    return store.conditional<D>(path, baseRevision, (current) => {
      if (current.payout) {
        if (!sameTerms(current.payout, fixed))
          throw new Error('An existing payout has different terms');
        return current;
      }
      const next = commit(current, payout);
      if (next.origin !== current.origin || !isDeepStrictEqual(next.payout, payout))
        throw new Error('Payment commit must preserve the prepared payout and document origin');
      return next;
    });
  }

  async function send(path: string): Promise<void> {
    const stored = await store.required<PaymentDocument>(path);
    const payout = stored.value.payout;
    if (
      !payout ||
      payout.status === 'paid' ||
      payout.status === 'needs_attention' ||
      payout.attempt.claim !== null
    )
      return;
    // Capture the attempt before competing for its claim. A CAS retry must not
    // accidentally claim a replacement and submit the old prepared transaction.
    const attemptId = payout.attempt.id;
    const claim = randomUUID();
    const claimed = await store.change<PaymentDocument>(path, (current) => {
      const payment = current.payout;
      if (
        !payment ||
        payment.status === 'paid' ||
        payment.status === 'needs_attention' ||
        payment.attempt.id !== attemptId ||
        payment.attempt.claim !== null
      )
        return current;
      return { ...current, payout: { ...payment, attempt: { ...payment.attempt, claim } } };
    });
    const installed = claimed.payout;
    if (!installed || installed.attempt.id !== attemptId || installed.attempt.claim !== claim)
      return;

    // Errors deliberately propagate. The persisted claim prevents duplicate
    // hosted sends; the watched attempt remains available to reference handling.
    const signature = await primitives.send(installed.attempt, installed.payee);
    await store.change<PaymentDocument>(path, (current) => {
      const payment = current.payout;
      if (
        !payment ||
        payment.status === 'paid' ||
        payment.attempt.id !== attemptId ||
        payment.attempt.claim !== claim
      )
        return current;
      return {
        ...current,
        payout: {
          ...payment,
          // A late answer does not restart an expired watch or erase the manual
          // handoff. It only contributes the now-known transaction identity.
          status: payment.status === 'needs_attention' ? 'needs_attention' : 'sent',
          attempt: { ...payment.attempt, signature },
        },
      };
    });
  }

  async function paid(path: string, attemptId: string, signature: string): Promise<void> {
    await store.change<PaymentDocument>(path, (current) => {
      const payout = current.payout;
      if (!payout || payout.status === 'paid' || payout.attempt.id !== attemptId) return current;
      if (payout.attempt.signature !== null && payout.attempt.signature !== signature)
        throw new Error('Payout confirmation conflicts with the recorded submission');
      return {
        ...current,
        payout: {
          ...payout,
          status: 'paid',
          signature,
          issue: null,
          attempt: { ...payout.attempt, signature },
        },
      };
    });
  }

  async function confirm(path: string, reference: string, signature: string): Promise<void> {
    const stored = await store.required<PaymentDocument>(path);
    const payout = stored.value.payout;
    if (!payout || payout.status === 'paid' || payout.attempt.reference !== reference) return;
    try {
      await primitives.verify(payout.attempt, signature);
    } catch (error) {
      if (!(error instanceof PayoutReceiptMismatch)) throw error;
      await unresolved(path, payout.attempt.id);
      return;
    }
    await paid(path, payout.attempt.id, signature);
  }

  async function replace(path: string, document: PaymentDocument): Promise<void> {
    const previous = document.payout!;
    const attempt = await prepare(path, document, previous);
    if (Date.parse(attempt.expiresAt) <= now())
      throw new Error(
        'Replacement payout reference expired before installation; retry this delivery',
      );
    const written = await store.conditional<PaymentDocument>(path, document.revision, (current) => {
      const payout = current.payout;
      if (!payout || payout.status === 'paid' || payout.attempt.id !== previous.attempt.id)
        return current;
      return {
        ...current,
        payout: {
          ...payout,
          status: 'pending',
          attempt,
          retired: [...payout.retired, payout.attempt],
          signature: null,
          issue: null,
        },
      };
    });
    if (written?.payout?.attempt.id === attempt.id) {
      await send(path);
      return;
    }
    const current = (await store.required<PaymentDocument>(path)).value.payout;
    if (current && current.attempt.id === previous.attempt.id && current.status !== 'paid')
      throw new Error('Payout changed during reconciliation; retry this delivery');
    // A different installed attempt has its own reference. Its winning operation
    // owns submission, so this stale event need not send on its behalf.
  }

  async function inspect(path: string, document: PaymentDocument): Promise<void> {
    const payout = document.payout!;
    const evidence = await primitives.reconcile(payout.attempt);
    if (evidence.status === 'paid') {
      await paid(path, payout.attempt.id, evidence.signature);
    } else if (evidence.status === 'retryable') {
      // Even an injected primitive must not promote an unsupported hosted
      // retirement guarantee into an independent second transfer.
      if (payout.attempt.mode === 'signed') await replace(path, document);
      else await unresolved(path, payout.attempt.id);
    } else {
      await unresolved(path, payout.attempt.id);
    }
  }

  async function unresolved(path: string, attemptId: string): Promise<void> {
    await store.change<PaymentDocument>(path, (current) => {
      const payout = current.payout;
      if (
        !payout ||
        payout.status === 'paid' ||
        payout.attempt.id !== attemptId ||
        (payout.status === 'needs_attention' && payout.issue === 'payout_outcome_unresolved')
      )
        return current;
      return {
        ...current,
        payout: { ...payout, status: 'needs_attention', issue: 'payout_outcome_unresolved' },
      };
    });
  }

  async function expire(path: string, reference: string): Promise<void> {
    const document = (await store.required<PaymentDocument>(path)).value;
    const payout = document.payout;
    if (!payout || payout.status === 'paid' || payout.attempt.reference !== reference) return;
    // No sender can execute an unclaimed attempt after this exact-revision swap:
    // its claim must still name the old attempt and compete with the replacement.
    if (payout.attempt.claim === null) await replace(path, document);
    else await inspect(path, document);
  }

  /** Explicit operator action; no timer, scanner or automatic retry loop invokes it. */
  async function reconcile(path: string): Promise<void> {
    const document = (await store.required<PaymentDocument>(path)).value;
    const payout = document.payout;
    if (!payout || payout.status === 'paid') return;
    if (payout.attempt.claim === null) {
      if (Date.parse(payout.attempt.expiresAt) <= now()) await replace(path, document);
      else await send(path);
    } else {
      await inspect(path, document);
    }
  }

  return { install, send, confirm, expire, reconcile };
}
