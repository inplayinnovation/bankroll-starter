# P2P mode

`createP2P` binds the deployment's store, payout signer and payment-address
adapter to three game hooks. The mode imports no game. [types.ts](./types.ts)
is the contract; [AGENTS.md](../../../AGENTS.md) contains shared app and
session guidance.

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
separate writes. `payout` at the root is a cancelled paid entry's refund; a
match's payout lives on `matches/<match-id>.json`.

`schema` identifies the envelope and `kind` is the game's compatibility key.
Unsupported documents remain untouched. Layout changes require a data migration
before using a store with outstanding entries; resetting throwaway dev data is
also possible.

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

**Bankroll watches every reference the mode mints.** `createEntry` asks
Bankroll for a managed reference (`createManagedReference`, meta `{ kind:
'entry', wallet, id }`) and records it, the memo and the client's idempotency
key on the round before the host sees them. Bankroll polls the chain for the
charge carrying it and delivers `reference.confirmed` to
`/api/bankroll/webhook`; an entry the host never paid for gets
`reference.expired` and ends. The webhook is the only way an entry gets
paid: a page never reports a signature, it polls the round. `confirmEntry`
runs `checkCharge`, which reads the transaction from the app's RPC and
compares payee, payer, mint, amount and the entry memo, and only then is the
signature recorded. The memo names the entry, so one charge
can buy one entry only. A payment reported after a confirmed cancellation
still gets recorded and refunded. A page whose `charge()` threw cancels the
entry at once; unpaid and never queued, it closes locally with no refund and
no matchmaking call. Host balances never authorize a purchase or payout.

**One match owns one settlement.** Both round snapshots must be terminal
before an atomic create at `matches/<match-id>.json` fixes the outcome and the
money owed. The game exposes opponent results only after settlement. Every
real player has a recipient line, including a loser at zero; a creator
distinct from the payee also has a line, zero on a tie. All lines share one
transaction and its `duel:<id>` memo. The SDK's synthetic development
opponent has no payable wallet and is excluded. Refunds carry `refund:<id>`.

**Paying is inline, and Bankroll reports the landing.** A transition that
leaves a round owing money, or a read that finds the opponent past the start
deadline, pays before the request answers: `settle.ts` asks Bankroll for a
managed reference for the attempt (meta `{ kind: 'payout', path, origin }`,
window = the signer's replay window, or five minutes for a keypair), builds
the transaction with it, records reference, idempotency key and bytes on the
owing document, then sends. Nothing waits for the chain. Bankroll's
`reference.confirmed` marks the document paid when its signature is the one
the send answered (a lost answer is taken on Bankroll's word);
`reference.expired` means the attempt is dead and `settle` builds a fresh
one. Inside the window, once the send has had time to answer and has not, a
retry resends the same bytes under the same key, so a crash between the write
and the send costs nothing. A failed send never
fails the request: the next request to touch the round, or the expiry, pays.
There is no worker, lease, index or cron. The one clock-driven case, a no-show
after matching, has Bankroll as its alarm: a matched entry mints a reference
nobody will pay, expiring at its start deadline, and that expiry brings the
webhook back to settle the forfeit when neither player reads the round.

## Files and tests

`entries.ts` defines the shared document transitions and the inline pay
trigger. `terms.ts` hashes the game compatibility key, saved money terms and
no-show window into the queue; `rules.ts` provides defaults for the policy
parameters. `payments.ts` confirms and expires entries; `matching.ts` owns
tickets; `settlement.ts` records the outcome and recipients; `settle.ts` pays
what a document owes; `webhook.ts` turns Bankroll's events into those calls.
Only `settle.ts` sends money.

The app's `src/app/api/bankroll/webhook/route.ts` serves the SDK's
`referenceWebhook`; a game passes it `p2p.webhook`, as the
[recipe](../../../recipes/p2p.md) shows. The route refuses a delivery it
cannot verify; under the mock it accepts the unsigned ones the mock host and
the mock payout signer send.

`test/p2p.test.ts` drives this code with a game defined entirely in the test,
against the selected real store, with the SDK queue and the mock signer real
and the test standing in for Bankroll: it collects the events the mock
delivers and feeds them to `p2p.webhook`. Keep the start/cancel races,
late-payment refunds, fee/tie/forfeit cases, the webhook-first payment, entry
expiry, and the expired-attempt rebuild.
