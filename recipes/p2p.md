# P2P

## What it is and when to use it

Paid, asynchronous two-player entries with SDK matchmaking and settlement
watched by Bankroll. Prompt signals include “play against a friend”, “bet a
dollar”, “win money”, and “head-to-head”; this mode supplies a queue, not
friend invites or opponent selection. [test/p2p.test.ts](../test/p2p.test.ts)
is the smallest complete game on the mode, entry to settlement.
[Mode invariants](../src/lib/p2p/README.md) live beside the implementation.

## Decisions

| Decision | Current default and source | What a prompt changes |
| --- | --- | --- |
| Entry price | `policy.entryCents: 100` in [rules.ts](../src/lib/p2p/rules.ts) | “Bet $5” → `entryCents: 500`. |
| Creator's cut | `policy.creatorFeeBps: 1_000`: 10% of the combined pot, only on a win | “No fee” → `creatorFeeBps: 0`; another percentage changes this override. Resulting amounts must be whole cents. |
| No-show window | `policy.startWindowMs: 300_000`: five minutes **after matching** to start | “Start within a minute” → `startWindowMs: 60_000`. It is not an unmatched-queue timeout. |
| Ties | [settlement.ts](../src/lib/p2p/settlement.ts) returns both stakes, no fee | A tiebreaker belongs in the game's `outcome` hook. Different tie payments require a mode change; there is no policy override. |
| Creator wallet | The binding below uses the payee for a normal treasury, `BANKROLL_OWNER` for a Bankroll server wallet | Another recipient changes `paymentTerms().creatorWallet`. This is a binding choice, not a `rules.ts` default. |

## The flow, walked with one player and dollars

1. Alice enters. `prepareEntry` checks the webhook secret and SDK access, then
   `createEntry` asks Bankroll for a managed reference and writes
   `games/<wallet>/<id>.json` with her $1 terms, the reference and her
   payment key. Bankroll is now watching the chain for that reference.
2. The host charges Alice $1 with the reference and the entry memo. Bankroll
   sees it land and delivers `reference.confirmed` to
   `/api/bankroll/webhook`: `checkCharge` reads the transaction from the
   app's RPC against her terms, and the signature is CAS-written onto the
   round. Her page polls the round; it never reports the signature itself.
   If `charge()` throws instead, because she dismissed the sheet or the
   bridge failed, the page cancels the entry at once rather than leaving it
   pending until Bankroll reports the reference expired:

   ```ts
   try {
     await bankroll.charge({ amountCents: 100, memo: round.payment.memo, idempotencyKey: round.payment.key, reference: round.payment.reference });
   } catch (error) {
     await api({ action: 'cancel', id: round.id }); // unpaid: closes locally, no refund, no matchmaking call
     throw error;
   }
   ```
3. `syncEntry` submits/retrieves the SDK ticket; `adoptTicket` saves accepted
   conditions on the round. Bob enters the same queue and both receive the same
   accepted conditions, including the seed. Inside a round CAS, `startEntry`
   closes cancellation while the game initializes and reveals play state.
4. The request that ends the second round pays before it answers:
   `matches/<match-id>.json` is created atomically (if Alice wins: Alice
   $1.80, Bob $0, the distinct creator $0.20, memo `duel:<id>`), Bankroll
   mints a reference for the payout, the transaction is built with it,
   recorded on the match document, and sent, all lines in one transaction. A
   normal treasury retains its $0.20 instead of sending to itself. A tie
   returns $1 each, with a zero creator line when its wallet is distinct.
   Bankroll delivers `reference.confirmed` when it lands and the document is
   marked paid; the result screen's next poll shows it. A read that finds the
   opponent past the start deadline pays the forfeit the same way, and so does
   the Bankroll timer each matched entry sets for that deadline, so a no-show
   is settled even when nobody comes back to look.
5. If nobody joins while Alice waits and she has **not started**,
   `cancelEntry` obtains an SDK cancellation, prepares the $1 refund (its
   reference and bytes), records it with the cancellation on her round under
   `payout` with `refund:<id>`, then sends it the same way. There is no
   automatic unmatched timeout. Starting or being matched prevents
   cancellation; missing the matched start window forfeits rather than
   refunds. An entry the host never paid for ends when Bankroll reports its
   reference expired.

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
tickets and money; the game owns play, result comparison and screens. One
round document holds `game` and `entry` sections: start and cancellation share
a CAS. A refund's `payout` field stays at the root.

If play involves acting at the right moment, read [latency](./latency.md)
before designing the round: the server only knows when a request arrived.

Bind the game once, in a server module of its own:

```ts
import { HSUSD_MINT } from '@joinbankroll/sdk/server';
import { createP2P } from '@/lib/p2p';
import { storeBackend } from '@/lib/store';
import { ownerAddress, payeeAddress, payoutSigner, serverWalletConfigured } from '@/lib/treasury';
import { hooks } from './state'; // your game's hooks

export const p2p = createP2P({
  hooks,
  store: storeBackend(),
  payoutSigner,
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

Bind the webhook route to the game: in `src/app/api/bankroll/webhook/route.ts`,
`export const POST = bankrollWebhook(p2p.webhook)`. Without a game binding,
main's route acknowledges deliveries and does nothing with them. Live
matchmaking and references use `BANKROLL_APP_KEY` and `BANKROLL_SIGNED_MANIFEST`;
the route verifies deliveries with `BANKROLL_WEBHOOK_SECRET` (see
[.env.example](../.env.example)). All three come with verification; the
builder sets them.

## How to check it here

With an existing dev server using `BANKROLL_MOCK=1`:

```bash
npm run check -- /app '/app?tab=results' /
STORE=fs npm test
```

Main's pages show the skeleton; the worked example adds gameplay. With a bound
game, the SDK mock adds a stand-in opponent after three seconds; it never plays
and forfeits at the start deadline. Under the mock nothing reaches Bankroll:
references and timers are minted locally, the mock host's `charge()` and the
mock payout signer deliver `reference.confirmed` to the webhook route
themselves, the window's end delivers `reference.expired` and a timer delivers
`timer.fired` when it fires, so the whole money path runs with
no key and no RPC. [test/p2p.test.ts](../test/p2p.test.ts) is the smallest
working game and money-flow example.

## Combining

P2P plus practice is a paid game plus a free round with `entry: null`. The game
creates and plays that round without a payment, ticket or payout.
