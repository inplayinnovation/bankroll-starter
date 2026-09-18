# P2P

## What it is and when to use it

Paid, asynchronous two-player entries with SDK matchmaking and recoverable
settlement. Prompt signals include “play against a friend”, “bet a dollar”,
“win money”, and “head-to-head”; this mode supplies a queue, not friend invites
or opponent selection. [test/p2p.test.ts](../test/p2p.test.ts) is the smallest
complete game on the mode, entry to settlement. [Mode invariants](../src/lib/p2p/README.md)
live beside the implementation.

## Decisions

| Decision | Current default and source | What a prompt changes |
| --- | --- | --- |
| Entry price | `policy.entryCents: 100` in [rules.ts](../src/lib/p2p/rules.ts) | “Bet $5” → `entryCents: 500`. |
| Creator's cut | `policy.creatorFeeBps: 1_000`: 10% of the combined pot, only on a win | “No fee” → `creatorFeeBps: 0`; another percentage changes this override. Resulting amounts must be whole cents. |
| No-show window | `policy.startWindowMs: 300_000`: five minutes **after matching** to start | “Start within a minute” → `startWindowMs: 60_000`. It is not an unmatched-queue timeout. |
| Ties | [settlement.ts](../src/lib/p2p/settlement.ts) returns both stakes, no fee | A tiebreaker belongs in the game's `outcome` hook. Different tie payments require a mode change; there is no policy override. |
| Creator wallet | The binding below uses the payee for a normal treasury, `BANKROLL_OWNER` for a Bankroll server wallet | Another recipient changes `paymentTerms().creatorWallet`. This is a binding choice, not a `rules.ts` default. |

## The flow, walked with one player and dollars

1. Alice enters. `prepareEntry` checks scheduler configuration and SDK access,
   then `createEntry` writes `reconciliation/entries/<id>.json` followed by
   `games/<wallet>/<id>.json`, including her $1 terms, reference and payment key.
2. The host charges Alice $1. `confirmEntry` asks SDK `claimCharge` to create a
   receipt under `receipts/<payer>/`, then CAS-writes her signature onto the round.
3. `syncEntry` submits/retrieves the SDK ticket; `adoptTicket` saves accepted
   conditions on the round. Bob enters the same queue and both receive the same
   accepted conditions, including the seed. Inside a round CAS, `startEntry`
   closes cancellation while the game initializes and reveals play state.
4. The request that ends the second round returns at once, and settlement
   runs in its background: the mode hands `worker.reconcileEntry` to the
   binding's `after` (Next's `after` from `next/server`), which runs once the
   response is sent. `worker.resolveMatch` atomically creates
   `matches/<match-id>.json` (if Alice wins: Alice $1.80, Bob $0, the distinct
   creator $0.20, with `duel:<id>`) and the SDK payout goes out, all lines in
   one transaction; the result screen's next poll shows it paid, seconds
   later. The mode schedules that on transitions that leave money owed, and
   on a read once the opponent's start deadline has passed; a plain poll of
   a settled round schedules nothing. A request handler never calls the
   worker itself. The hourly cron is the backstop for whoever was not there. A normal treasury retains its $0.20 instead of sending to itself.
   A tie returns $1 each, with a zero creator line when its wallet is distinct.
5. If nobody joins while Alice waits and she has **not started**,
   `cancelEntry` obtains an SDK cancellation and records a $1 refund on her
   round under `payout`, with `refund:<id>`; reconciliation pays it. There is no
   automatic unmatched timeout. Starting or being matched prevents cancellation;
   missing the matched start window forfeits rather than refunds.

## What the game supplies

The three hooks have these signatures in [types.ts](../src/lib/p2p/types.ts):

```ts
export interface GameHooks<Game, Conditions extends Json> {
  conditions: {
    key: string;
    validate(payload: unknown): Conditions;
  };
  terminal(game: Readonly<Game>, now: number): Terminal<Game> | null;
  outcome(a: Readonly<FinalRound<Game>>, b: Readonly<FinalRound<Game>>): Outcome;
}
```

`conditions.key` identifies compatible rules and limits, excluding the proposed
seed. `terminal` returns a final `{ game, reason }` snapshot; `outcome` returns
a win/forfeit with the winner's entry ID, or a tie. The mode owns entries,
tickets, money and the worker; the game owns play, result comparison and screens.
One round document holds `game` and `entry` sections: start and cancellation
share a CAS. The SDK refund `payout` field stays at the root.

If play involves acting at the right moment, read [latency](./latency.md)
before designing the round: the server only knows when a request arrived.

Bind the game once, in a server module of its own:

```ts
import { after } from 'next/server';
import { HSUSD_MINT } from '@joinbankroll/sdk/server';
import { createP2P } from '@/lib/p2p';
import { storeBackend } from '@/lib/store';
import { ownerAddress, payeeAddress, payoutSigner, serverWalletConfigured } from '@/lib/treasury';
import { hooks } from './state'; // your game's hooks

export const p2p = createP2P({
  hooks,
  store: storeBackend(),
  signer: payoutSigner,
  // Settles in the background of the request that left money owed.
  after,
  paymentTerms: () => {
    const payee = payeeAddress() ?? '';
    return {
      payee,
      creatorWallet: serverWalletConfigured() ? (ownerAddress() ?? '') : payee,
      mint: HSUSD_MINT,
    };
  },
  policy: { entryCents: 100, creatorFeeBps: 1_000, startWindowMs: 300_000 },
});
```

A prepare route reads the session, then calls game and mode functions. Here
`newGame`, `proposal` and `gameView` are game functions from the worked example:

```ts
const { user } = await requireSession(request);
if (!user.identity) return Response.json({ error: 'identity_required' }, { status: 403 });
const game = newGame();
const round = await p2p.prepareEntry(user.wallet, await getOrigin(), game, proposal(game));
return Response.json({ game: gameView(round) }, { headers: { 'cache-control': 'private, no-store' } });
```

Bind the cron route with `reconciliationRoute(request, p2p.worker.runReconciliation)`.
Without a game binding, main's authenticated route is a no-op: `200 { skipped: true, reason: 'p2p_not_configured' }`.
Live matchmaking uses `BANKROLL_APP_KEY` and `BANKROLL_SIGNED_MANIFEST`;
the scheduled endpoint uses `CRON_SECRET` (see [.env.example](../.env.example)).

## How to check it here

With an existing dev server using `BANKROLL_MOCK=1`:

```bash
npm run check -- /app '/app?tab=results' /
npm run reconcile              # one pass against that server; needs CRON_SECRET
npm run reconcile -- --watch   # repeat locally; next dev does not schedule cron
STORE=fs npm test
```

Main's pages show the skeleton; the worked example adds gameplay. With a bound
game, the SDK mock adds a stand-in opponent after three seconds; it never plays
and forfeits at the start deadline. Under the mock the whole payout path runs
without an RPC: a mock signer's payout is built, sent and confirmed with
made-up values and no money moves.
[test/p2p.test.ts](../test/p2p.test.ts) is the smallest working game and money-flow
example. `vercel.json` schedules the authenticated endpoint hourly, as the
backstop behind background settlement.

## Combining

P2P plus practice is a paid game plus a free round with `entry: null`. The game
creates and plays that round without a payment, ticket or payout.
