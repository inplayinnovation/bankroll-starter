import { PayError } from '@joinbankroll/sdk/server';
import { describe, expect, it, vi } from 'vitest';

import type { Payout } from '../model';
import { PayoutReceiptMismatch } from '../bankroll';
import { createPayments, type PaymentDocument, type PaymentSpec } from '../payments';
import { createPersistence } from '../storage';
import { createHarness } from './harness';

interface Owner extends PaymentDocument {
  outcome: 'open' | 'decided';
  other: number;
}

const path = 'engine/matches/one.json';

async function fixture(mode: 'signed' | 'hosted' = 'signed') {
  const harness = createHarness({ mode });
  const store = createPersistence(harness.store);
  await store.create<Owner>(path, {
    revision: 0,
    origin: harness.origin(),
    outcome: 'open',
    other: 0,
    payout: null,
  });
  const payments = createPayments({
    store,
    primitives: harness.primitives,
    namespace: 'engine',
    now: harness.now,
    watchSeconds: () => 900,
  });
  const spec: PaymentSpec = {
    id: 'match:one',
    payee: harness.treasury.terms().payee,
    recipients: [{ to: 'alice', amountCents: 180, token: harness.treasury.terms().mint }],
    memo: 'match:one',
  };
  const read = async () => (await store.required<Owner>(path)).value;
  const payout = async () => (await read()).payout!;
  const commit = (current: Owner, payment: Payout): Owner => ({
    ...current,
    outcome: 'decided',
    payout: payment,
  });
  const install = async () => payments.install(path, (await read()).revision, spec, commit);
  return { harness, store, payments, spec, read, payout, commit, install };
}

describe('watched payout installation', () => {
  it('commits the decision with its first registered attempt without sending', async () => {
    const test = await fixture();
    const written = await test.install();
    const payout = written!.payout!;
    expect(written).toMatchObject({ revision: 1, outcome: 'decided' });
    expect(payout).toMatchObject({
      id: test.spec.id,
      status: 'pending',
      signature: null,
      retired: [],
    });
    expect(payout.attempt.claim).toBeNull();
    expect(test.harness.references.get(payout.attempt.reference)?.meta).toEqual({
      engine: 'engine',
      kind: 'payout',
      path,
      token: payout.attempt.id,
      baseRevision: 0,
    });
    expect(test.harness.sends).toHaveLength(0);
    expect(test.harness.timers.size).toBe(0);
  });

  it('leaves the decision unwritten when registration fails or its answer is lost', async () => {
    const test = await fixture();
    test.harness.failNext('reference.after');
    await expect(test.install()).rejects.toThrow('reference.after');
    expect(await test.read()).toMatchObject({ revision: 0, outcome: 'open', payout: null });
    expect(test.harness.sends).toHaveLength(0);
  });

  it('does not install after early expiry fenced the original revision', async () => {
    const test = await fixture();
    test.harness.on('reference.after', async () => {
      await test.store.fence(path, 0);
    });
    expect(await test.install()).toBeNull();
    expect(await test.read()).toMatchObject({ revision: 1, outcome: 'open', payout: null });
    expect(test.harness.sends).toHaveLength(0);
  });

  it('does not attach a preparation to a newer revision after an unrelated write', async () => {
    const test = await fixture();
    test.harness.on('prepare.after', async () => {
      await test.store.change<Owner>(path, (current) => ({ ...current, other: 1 }));
    });
    expect(await test.install()).toBeNull();
    expect(await test.read()).toMatchObject({ outcome: 'open', other: 1, payout: null });
  });

  it('does not knowingly install an observation that already expired', async () => {
    const test = await fixture();
    test.harness.on('prepare.after', () => {
      test.harness.advance(901_000);
    });
    expect(await test.install()).toBeNull();
    expect((await test.read()).payout).toBeNull();
  });

  it('rejects changing the terms of an existing obligation', async () => {
    const test = await fixture();
    await test.install();
    const existing = await test.read();
    await expect(
      test.payments.install(
        path,
        existing.revision,
        {
          ...test.spec,
          recipients: [{ to: 'different-player', amountCents: 180 }],
        },
        test.commit,
      ),
    ).rejects.toThrow('different terms');
    expect(test.harness.references.size).toBe(1);
  });
});

describe('durable submission claims', () => {
  it('durably hands off a mismatching terminal receipt without marking the obligation paid', async () => {
    const test = await fixture('hosted');
    await test.install();
    await test.payments.send(path);
    const attempt = (await test.payout()).attempt;
    vi.spyOn(test.harness.primitives, 'verify').mockRejectedValue(new PayoutReceiptMismatch());
    await test.payments.confirm(path, attempt.reference, 'unrelated-dust-transaction');
    expect(await test.payout()).toMatchObject({
      status: 'needs_attention',
      signature: null,
      issue: 'payout_outcome_unresolved',
    });
    await test.payments.send(path);
    expect(test.harness.sends).toHaveLength(1);
    expect(test.harness.attempts.size).toBe(1);
  });

  it.each(['signed', 'hosted'] as const)('only the winning %s claim submits', async (mode) => {
    const test = await fixture(mode);
    await test.install();
    await Promise.all([test.payments.send(path), test.payments.send(path)]);
    expect(test.harness.sends).toHaveLength(1);
    expect(test.harness.transfers).toHaveLength(1);
    expect(await test.payout()).toMatchObject({
      status: 'sent',
      attempt: { claim: expect.any(String) },
    });
    await test.payments.send(path);
    expect(test.harness.sends).toHaveLength(1);
  });

  it('preserves the claim and throws on an interrupted hosted send', async () => {
    const test = await fixture('hosted');
    await test.install();
    test.harness.failNext('send.before');
    await expect(test.payments.send(path)).rejects.toThrow('send.before');
    expect(await test.payout()).toMatchObject({
      status: 'pending',
      attempt: { claim: expect.any(String) },
    });
    await test.payments.send(path);
    expect(test.harness.sends).toHaveLength(1);
    expect(test.harness.transfers).toHaveLength(0);
    expect(test.harness.timers.size).toBe(0);
  });

  it('recovers a lost hosted send response through its confirmation without resending', async () => {
    const test = await fixture('hosted');
    await test.install();
    test.harness.failNext('send.after');
    await expect(test.payments.send(path)).rejects.toThrow('send.after');
    const attempt = (await test.payout()).attempt;
    const transfer = test.harness.transfers[0];
    expect(attempt.signature).toBeNull();
    await test.payments.confirm(path, attempt.reference, transfer.signature);
    await test.payments.send(path);
    expect(await test.payout()).toMatchObject({ status: 'paid', signature: transfer.signature });
    expect(test.harness.sends).toHaveLength(1);
  });

  it('does not downgrade a confirmation that beats the send response write', async () => {
    const test = await fixture();
    await test.install();
    const attempt = (await test.payout()).attempt;
    test.harness.on('send.after', async ({ signature }) => {
      await test.payments.confirm(path, attempt.reference, signature as string);
    });
    await test.payments.send(path);
    expect(await test.payout()).toMatchObject({ status: 'paid', signature: attempt.signature });
  });

  it('does not claim a replacement and accidentally submit stale prepared bytes', async () => {
    const test = await fixture('hosted');
    await test.install();
    const old = (await test.payout()).attempt;
    test.harness.on('store.write.before', async () => {
      test.harness.expireAttempt(old.id);
      await test.payments.expire(path, old.reference);
    });
    await test.payments.send(path);
    const current = await test.payout();
    expect(current.attempt.id).not.toBe(old.id);
    expect(current.retired[0]).toMatchObject({ id: old.id, claim: null });
    expect(test.harness.sends).toHaveLength(1);
    expect(test.harness.sends[0].id).toBe(current.attempt.id);
  });

  it('preserves manual reconciliation when a hosted send returns after its watch expired', async () => {
    const test = await fixture('hosted');
    await test.install();
    const old = (await test.payout()).attempt;
    test.harness.on('send.before', async () => {
      test.harness.expireAttempt(old.id);
      await test.payments.expire(path, old.reference);
    });
    await test.payments.send(path);
    expect(await test.payout()).toMatchObject({
      status: 'needs_attention',
      issue: 'payout_outcome_unresolved',
      attempt: { id: old.id, signature: test.harness.transfers[0].signature },
    });
    await test.payments.reconcile(path);
    expect((await test.payout()).status).toBe('paid');
    expect(test.harness.transfers).toHaveLength(1);
  });
});

describe('expiry and evidence', () => {
  it.each(['signed', 'hosted'] as const)(
    'safely replaces an unclaimed expired %s attempt',
    async (mode) => {
      const test = await fixture(mode);
      await test.install();
      const old = (await test.payout()).attempt;
      test.harness.expireAttempt(old.id);
      const reconcile = vi.spyOn(test.harness.primitives, 'reconcile');
      await test.payments.expire(path, old.reference);
      const current = await test.payout();
      expect(current.id).toBe(test.spec.id);
      expect(current.attempt.id).not.toBe(old.id);
      expect(current.retired).toEqual([old]);
      expect(reconcile).not.toHaveBeenCalled();
      expect(test.harness.transfers).toHaveLength(1);
      expect(test.harness.timers.size).toBe(0);
    },
  );

  it('requires a delivery retry if the old attempt is claimed during replacement preparation', async () => {
    const test = await fixture('hosted');
    await test.install();
    const old = (await test.payout()).attempt;
    test.harness.expireAttempt(old.id);
    test.harness.on('prepare.after', async () => {
      await test.payments.send(path);
    });
    await expect(test.payments.expire(path, old.reference)).rejects.toThrow('retry this delivery');
    expect((await test.payout()).attempt.id).toBe(old.id);
    await test.payments.expire(path, old.reference);
    expect((await test.payout()).status).toBe('paid');
    expect(test.harness.transfers).toHaveLength(1);
  });

  it('replaces a claimed signed attempt only with evidence it cannot pay', async () => {
    const test = await fixture();
    await test.install();
    const old = (await test.payout()).attempt;
    test.harness.failNext('send.before');
    await expect(test.payments.send(path)).rejects.toThrow();
    test.harness.setEvidence(old.id, 'retryable');
    test.harness.expireAttempt(old.id);
    await test.payments.expire(path, old.reference);
    const current = await test.payout();
    expect(current.retired[0]).toMatchObject({ id: old.id, claim: expect.any(String) });
    expect(current.attempt.id).not.toBe(old.id);
    expect(test.harness.transfers).toHaveLength(1);
  });

  it('retains hosted ambiguity even if a primitive claims replacement is permitted', async () => {
    const test = await fixture('hosted');
    await test.install();
    const old = (await test.payout()).attempt;
    test.harness.failNext('send.before');
    await expect(test.payments.send(path)).rejects.toThrow();
    test.harness.setEvidence(old.id, 'retryable');
    await test.payments.expire(path, old.reference);
    expect(await test.payout()).toMatchObject({
      status: 'needs_attention',
      attempt: { id: old.id },
      retired: [],
    });
    expect(test.harness.references.size).toBe(1);
  });

  it('throws transient reconciliation failures without acknowledging manual handoff', async () => {
    const test = await fixture();
    await test.install();
    const old = (await test.payout()).attempt;
    test.harness.failNext('send.before');
    await expect(test.payments.send(path)).rejects.toThrow();
    const error = new PayError('rpc_error', 'receipt query unavailable');
    test.harness.failNext('reconcile.before', error);
    await expect(test.payments.expire(path, old.reference)).rejects.toBe(error);
    expect(await test.payout()).toMatchObject({ status: 'pending', issue: null, retired: [] });
  });

  it('ignores stale reference events after installing a replacement', async () => {
    const test = await fixture();
    await test.install();
    const old = (await test.payout()).attempt;
    await test.payments.expire(path, old.reference);
    const current = await test.read();
    await test.payments.expire(path, old.reference);
    await test.payments.confirm(path, old.reference, 'unrelated');
    expect(await test.read()).toEqual(current);
    expect(test.harness.sends).toHaveLength(1);
  });

  it('does not overwrite a known submission with a conflicting confirmation after verification raced', async () => {
    const test = await fixture('hosted');
    await test.install();
    const attempt = (await test.payout()).attempt;
    vi.spyOn(test.harness.primitives, 'verify').mockImplementation(async () => {
      await test.store.change<Owner>(path, (current) => ({
        ...current,
        payout: {
          ...current.payout!,
          attempt: { ...current.payout!.attempt, signature: 'actual-submission' },
        },
      }));
    });
    await expect(
      test.payments.confirm(path, attempt.reference, 'conflicting-candidate'),
    ).rejects.toThrow('conflicts');
    expect((await test.payout()).status).not.toBe('paid');
  });
});
