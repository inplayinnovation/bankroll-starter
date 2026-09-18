# P2P mode

`createP2P` binds the deployment's store, signer and payment-address adapter to
three game hooks. The mode imports no game. [types.ts](./types.ts) is the
contract; [AGENTS.md](../../../AGENTS.md) contains shared app and session guidance.

- `conditions.key` identifies compatible game rules and limits, excluding
  proposed randomness. `conditions.validate(payload)` rejects an unsupported
  accepted payload and returns its typed conditions. The game supplies the
  initial proposal when entering; the mode mints the entry ID and payment intent.
- `terminal(game, now)` returns null while playable, or `{ game, reason }` with
  the terminal snapshot. On expiry, the snapshot must include the final clock
  state. Return the same state on later calls; never extend its deadline.
- `outcome(a, b)` compares two terminal snapshots and returns a win, tie or
  forfeit with the winner's entry ID. No-show inputs have `reason: 'forfeited'`;
  only the SDK's development stand-in has `game: null`.

These hooks are pure: no storage, randomness or network calls. The mode checks
terminal state inside every CAS retry, persists expiry before using it for
settlement, and passes only terminal snapshots to `outcome`. Game actions must
leave terminal play state immutable. There is no game initialization, board
mutation or scoring callback inside the mode.

## One document

`games/<wallet>/<id>.json` holds `{ schema, kind, id, wallet, createdAt, game,
entry, payout }`. The game's state is opaque to P2P. `entry` owns accepted
conditions, original ticket input, admission state, money terms, and payment.
A null entry has no paid admission; practice creation and play belong to the
game. The null/non-null distinction cannot change after creation.

`entries.ts` owns the shared CAS. Inside that CAS, the game calls
`startEntry(entry, now)` and initializes its revealed play state in the same
returned document. Starting sets `entry.status = 'started'`, closing refunds
before either player's private play state is exposed. Never split this into
separate writes. `payout` stays at the root because that is the SDK helper's
owning-document contract; a cancellation refund never gets another document.

`schema` identifies the envelope and `kind` is the game's compatibility key.
Unsupported documents remain untouched. Layout changes require a data migration
before using a store with outstanding entries; resetting throwaway dev data is
also possible. `reconcile:index` repairs discovery pointers, not document formats.

## Admission and cancellation invariants

**Accepted conditions are shared, proposals are only retry inputs.** A waiting
ticket uses `admission.payload`; a matched ticket uses `match.payload`, including
for the joining player. `matching.ts` calls the game's validator and persists
accepted conditions in `entry.conditions`. Never modify the original
`ticketInput`, and never change accepted conditions after start. A stale waiting
response cannot replace a match, nor resurrect a cancelled ticket.

**Starting closes cancellation.** The entry and play state compete on one CAS.
After that, SDK pairing and SDK cancellation arbitrate the ticket: only a
confirmed cancellation permits a refund. A matched reply keeps the stake. A
played ticket has no matching expiry and remains queued. A matched entrant
that misses its stored start window forfeits; no refund follows play or a
no-show. Disconnecting does not undo the start marker or pause a game's clock.
The default window is five minutes. The outcome hook must distinguish a
forfeit from a played result, including a played result worth zero.

## Payment and settlement invariants

**Prices come from the server.** `rules.ts` defaults to $1 entries and a 10% creator
fee on the $2 pot. A win pays $1.80; a tie returns $1 to each player with no fee.
Prices and fees must be whole cents, so a 1¢ entry cannot represent this fee.
`terms.ts` snapshots the payee, currency, amounts, and fee recipient on
each entry. The normal treasury retains the fee; a Bankroll server wallet
sends it to `BANKROLL_OWNER`. Compatible terms and rules share a queue.

**Record an intent before charging.** The round owns its server-minted payment
reference, idempotency key, amount, and memo before the host sees them. First
create its immutable pointer at `reconciliation/entries/<id>.json`, then create
the game, then expose the quote. A crash can leave a pointer to a missing game;
it cannot leave a payable entry undiscoverable by the worker. Practice creates
no pointer. The flat index lists the same way on filesystem and Blob stores;
it is discovery metadata, never financial authority.

The scheduled worker recovers lost charge responses by reference, regardless
of age. Both live and recovered candidates must match payee, payer, stored mint,
amount, and entry memo. An RPC failure is not proof of nonpayment. Neither is
an expired app quote: the app does not know when a client last called the host
with it. Keep unresolved references eligible for later passes. Host balances
never authorize a purchase or payout.

**One transaction buys one entry.** SDK `claimCharge` writes an atomic,
immutable receipt at `receipts/<wallet>/<signature-digest>.json`. Its owner
is the full game document path, unique across modes in the same store.
The round's `entry` section records the signature with compare-and-swap.
A repeat claim with `created: false` still repairs an interrupted game write.
A payment reported after a confirmed cancellation still gets recorded and
refunded. Refuse to charge without the stored reference.

**One match owns one settlement.** Both round snapshots must be terminal
before an atomic create at `matches/<match-id>.json` fixes the outcome and payout.
The game exposes opponent results only after settlement. Every real player
has a recipient line, including a loser at zero; a creator distinct from the payee also has
a line, zero on a tie. All lines share one transaction and its `duel:<id>`
memo. The SDK's synthetic development opponent has no payable wallet and
is excluded. Refunds carry `refund:<id>`. This uses immutable terminal game
snapshots as inputs, not a transaction spanning multiple game documents. Each
payout transition uses compare-and-swap on that match document; an unmatched
cancellation owns its refund lifecycle on the round document's root `payout`
field.

**Player requests never execute payouts.** They confirm reported payments,
admit paid entries, or record cancellation obligations. Reads show stored
results. `reconcile.ts` alone calls `settlePayout`: it recovers pay-ins,
retries admission/cancellation, finalizes expired rounds, records match results,
and advances refunds and prizes. Existing settlement records can pay even
during a matchmaking outage. A paid entry stores its admission origin so a
scheduler request arriving on a deployment hostname uses the same SDK origin.

**The SDK owns payout recovery.** Pass the injected store and signer to
`settlePayout(path, { store, signer })`; the signer factory receives
the persisted attempt's key. The helper stores bytes, reference, key, and
any locally known signature before sending. It uses the signer's declared
replay window, reconciles unknown outcomes, and permits fresh bytes only when
nonpayment is proven. The last unresolved `PayError` code is on
`payout.attempt.error`. Never reset an attempt in app code because a send was
rejected or an RPC request failed.

## Files and tests

`entries.ts` defines the shared document transitions. `terms.ts` hashes the
game compatibility key, saved money terms and no-show window into the queue;
`rules.ts` provides defaults for the policy parameters. `payments.ts` is the
SDK receipt adapter. `matching.ts` owns tickets; `settlement.ts` records the
outcome and recipients. `entry-index.ts`, `reconcile.ts`, `worker.ts` and
`cron.ts` discover unfinished work, advance it, and protect the scheduled endpoint.
Only `reconcile.ts` calls SDK `settlePayout`.

A cron route without a bound worker answers `200 { skipped: true, reason: 'p2p_not_configured' }` after
authentication. Pass the game's `p2p.worker.runReconciliation` to
`reconciliationRoute` as shown in [the recipe](../../../recipes/p2p.md). The
worker's functions (`runReconciliation`, `reconcileEntry`, `resolveMatch`) live
under `p2p.worker`, apart from the player surface, because a player request
never executes a payout: the cron route is their one caller.

`test/p2p.test.ts` drives this code with a game defined entirely in the test. App suites keep the selected store and the SDK queue real, and mock
`claimCharge` and `settlePayout` at their public boundary. The SDK owns receipt
uniqueness and payout-attempt recovery tests. Keep the start/cancel races,
late-payment refunds, offline settlement, fee/tie/forfeit cases and lease tests.
