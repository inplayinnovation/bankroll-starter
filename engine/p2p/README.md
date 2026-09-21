# P2P engine

A headless engine for paid, asynchronous duels. Each player completes an
independent, bounded round; the game compares their results. Players may
start before an opponent arrives. The engine owns payments, matchmaking,
cancellation, deadlines and settlement. The app owns its rules and screens.

The starter stays empty: no game singleton, player routes or example UI are
installed. This guide shows the binding to add when building an app.
[notes/p2p-engine.md](../../notes/p2p-engine.md) records the design;
[types.ts](./types.ts) defines the public contract.

## Bind a game on the server

For example, create `src/lib/duel.ts`:

```ts
import { getOrigin } from '@joinbankroll/sdk/next';
import { HSUSD_MINT } from '@joinbankroll/sdk/server';

import { createP2PEngine } from '../../engine/p2p';
import { wordsGame } from '../../engine/p2p/examples/words';
import { storeBackend } from '@/lib/store';
import {
  ownerAddress, payeeAddress, payoutSigner, serverWalletConfigured,
} from '@/lib/treasury';

export const duel = createP2PEngine({
  game: wordsGame,
  store: storeBackend(),
  origin: getOrigin,
  offers: {
    default: { entryCents: 100, creatorFeeBps: 1_000 },
  },
  treasury: {
    terms() {
      const payee = payeeAddress();
      const creatorWallet = serverWalletConfigured() ? ownerAddress() : payee;
      if (!payee || !creatorWallet) throw new Error('Treasury is not configured');
      return { payee, creatorWallet, mint: HSUSD_MINT };
    },
    signer: payoutSigner,
  },
  authorizeOperator: (actor) => actor.wallet === ownerAddress(),
});
```

Replace the example with your own definition. Keep this singleton out of
browser imports. Treasury and operator authority come from server
configuration. An offer selects server-approved terms; browser inputs cannot
choose payout recipients or invent a price.

Defaults are a $1 entry, 10% creator fee on a win, a 24-hour queue cutoff,
and five minutes after pairing for an unstarted player to start. A $2 pot
pays $1.80 to the winner; the creator receives or retains $0.20. Ties and
double no-shows return both stakes without a fee. This version uses HSUSD, with amounts representable
as whole cents. Offers can override the policy values in [types.ts](./types.ts).

## Bind routes and the webhook

Each player operation receives an authenticated `{ wallet }` actor. Use the
session's wallet, never one supplied in the request body. One possible
`src/app/api/duel/route.ts` is:

```ts
import { getSession } from '@joinbankroll/sdk/next';
import { EngineError } from '../../../../engine/p2p';
import { duel } from '@/lib/duel';

export const runtime = 'nodejs';
const headers = { 'cache-control': 'private, no-store' };

export async function POST(request: Request) {
  const session = await getSession(request);
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (!session.user.identity)
    return Response.json({ error: 'identity_required' }, { status: 403 });
  const input = await request.json().catch(() => null);
  if (!input || typeof input !== 'object')
    return Response.json({ error: 'invalid_request' }, { status: 400 });

  const actor = { wallet: session.user.wallet };
  const { commandId, roundId } = input;
  try {
    let result;
    switch (input.type) {
      case 'enter':
        result = await duel.enter(actor, { commandId, offerId: input.offerId });
        break;
      case 'start':
        result = await duel.start(actor, { roundId, commandId });
        break;
      case 'act':
        result = await duel.act(actor, {
          roundId, commandId, sequence: input.sequence, action: input.action,
        });
        break;
      case 'cancel':
        result = await duel.cancel(actor, { roundId, commandId });
        break;
      default:
        return Response.json({ error: 'invalid_request' }, { status: 400 });
    }
    return Response.json(result, { headers });
  } catch (error) {
    if (!(error instanceof EngineError)) throw error;
    // The transport owns this mapping; core errors contain no HTTP status.
    const status = error.code.startsWith('invalid_') ? 400 : 409;
    return Response.json({ error: error.code }, { status, headers });
  }
}

export async function GET(request: Request) {
  const session = await getSession(request);
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const actor = { wallet: session.user.wallet };
  const query = new URL(request.url).searchParams;
  const roundId = query.get('roundId');
  const result = roundId
    ? await duel.get(actor, roundId)
    : await duel.history(actor, { cursor: query.get('cursor') ?? undefined });
  return Response.json(result, { headers });
}
```

Then replace the empty handlers in
`src/app/api/bankroll/webhook/route.ts` with:

```ts
import { bankrollWebhook } from '@joinbankroll/sdk/webhooks';
import { duel } from '@/lib/duel';

export const runtime = 'nodejs';
export const POST = bankrollWebhook(duel.webhook);
```

The SDK wrapper verifies deliveries before dispatching `onConfirmed`,
`onExpired` or `onFired`. The engine completes each event's consequences;
operational failures propagate so Bankroll can redeliver. Do not replace
failures with a successful acknowledgement.

Live references, matchmaking and timers require the verified app credentials
and webhook secret described in [.env.example](../../.env.example):
`BANKROLL_APP_KEY`, `BANKROLL_SIGNED_MANIFEST`, `BANKROLL_WEBHOOK_SECRET`.
They are separate from the treasury signer. `BANKROLL_MOCK=1` uses the SDK's
development stand-ins.

## Commands and client flow

| Operation | Input after actor | Result/behavior |
| --- | --- | --- |
| `enter` | `{ commandId, offerId? }` | Fix terms/version and return the watched payment request |
| `start` | `{ roundId, commandId }` | Reconcile admission, commit play and release the challenge |
| `act` | `{ roundId, commandId, sequence, action }` | Validate one input and apply its transition |
| `cancel` | `{ roundId, commandId }` | Cancel an eligible entry and establish any refund |
| `get` | `roundId` | Read one safe player view |
| `history` | `{ cursor?, limit? }` | Read a page of safe player views |

Commands return `{ command, round }`. Keep the same `commandId` and payload
through a transport retry. A new game action gets a new ID; retrying an action
gets its original ID. Reuse with different input is rejected. Send the last
acknowledged gameplay `sequence` with the next action; unrelated payment and
timer bookkeeping does not advance that sequence. Gameplay deadline transitions
do advance it; use the latest round view after a refresh.

Use the SDK's `bankrollFetch` on the client so requests carry the player's
session. After `enter`, retain the round ID and pass its `round.payment`
amount, memo, reference and idempotency key to `bankroll.charge`. Then read the
round until `allowed.start` is true. Verified payment automatically joins the
queue; the browser does not submit a receipt or call `sync`.

Starting needs payment and a live ticket, but no opponent. A successful server
start commits play, even if its response is lost; retry it to recover the same
board and clock. Cancellation is allowed only before both start and pairing.
A paid waiter can be matched while away and then forfeit at its start
deadline. Closing a page alone changes nothing. If a payment-sheet call fails,
the outcome may be uncertain: keep the entry and explicitly cancel or read it.

Views include `allowed`, `deadlines`, the permitted `game` view, the player's
`result`, match `outcome`, and independent `payout` status. Permissions are
enforced again on the server. A pending payout does not hide or change the
established result. Reads never advance the lifecycle or send money.

## Define the game

Import `defineGame` and `EngineError` from `engine/p2p/game` when writing rules.
That entry point is safe for browser simulation and practice; `engine/p2p`
exports the server engine. The contract is in [types.ts](./types.ts). The two complete,
pure examples are [words.ts](./examples/words.ts) and
[shooting.ts](./examples/shooting.ts).

```ts
type Progress<State, Result> =
  | { status: 'running'; state: State; nextDeadlineAt?: number }
  | { status: 'finished'; state: State; result: Result };
```

- `challenge(seed)` deterministically builds conditions; `parseChallenge`
  validates the accepted matchmaking conditions.
- `parseAction` validates untrusted action input. Invalid player input throws
  `EngineError('invalid_action', message)`.
- `start(context)` initializes play. `step(state, event, context)` processes
  either an action or a deadline. Both return `Progress`.
- `view(state, context)` exposes only the player's permitted game data.
- `compare(a, b)` compares actual completed results and returns `'a'`, `'b'`
  or `'tie'`. The engine resolves no-shows; a legitimate zero result is not
  a forfeit.

Hooks are synchronous, deterministic and free of network/storage effects.
They may run again after a conditional-write conflict. Return new state when
changing it. State, conditions, actions and results must be JSON-serializable.

Context provides `challenge`, `startedAt`, `endsAt`, `closesAt` and `now`.
`durationMs` determines the play window; `submissionGraceMs` adds time for an
upload. Inputs must satisfy the game's timing rules and an upload must reach
server admission before `closesAt`. A completed round cannot reopen. Deadline
events use the effective deadline as `now`, even if delivery was late.

`nextDeadlineAt` requests an intermediate gameplay deadline. The final cutoff
always remains in force, and the game must return a completed result there.
The word example scores tile paths as they arrive. The shooting example
recomputes a bounded trajectory replay and allows three seconds for submission
after play. A legal replay is not proof of human input; see
[the latency guide](../../recipes/latency.md).

Screens, animation and local simulation belong to the app. Practice may reuse
the same rules and renderer without paid entries. Keep practice results and
hidden future paid challenges separate.

## Operations and upgrades

There are only queue, no-show and game-deadline timers. Failed deliveries use
webhook redelivery; no periodic recovery job or recovery timer is required.
Early completion retains its existing legitimate deadline event until its
consequences are handled. Reference events own outgoing payment follow-up.

The engine validates payout receipts. Fixed signed transactions may be safely
replayed with their original identity. An ambiguous hosted submission may
remain `needs_attention`; expiry of its observer does not authorize a second
transfer or turn a prize into a stake refund.

For an authenticated operator, `duel.inspect(actor, { wallet, roundId })`
reads the receipt, obligation, recipients and attempt evidence without exposing
signed transaction bytes. Call `duel.reconcile(actor, { wallet, roundId })` from a separate protected route
or operator tool. Access is denied unless `authorizeOperator` is configured.
Reconciliation retries supported checks and processing; it is not permission
to send a replacement whose safety is unknown. Use delivery replay or inspect
the underlying signer evidence for faults that cannot resolve automatically.

Retain old definitions in `previousVersions` while their paid rounds remain.
The engine pins each entry's version, policy and treasury identity. Missing
rules or signing authority become explicit faults. Never repurpose engine
storage paths or replace treasury configuration to discard existing obligations.

## Checks

```bash
npm test -- engine/p2p/__tests__ test/environment.test.ts
npm run typecheck
npm run lint
```

The tests include pure game examples and isolated engine fixtures. The SDK
mock and test harness move no real funds. In-process development timers do
not by themselves prove process-restart recovery; the engine tests explicitly
drive interrupted operations and repeated deliveries.

After adding screens, also run the project's phone-sized browser checks and
inspect the screenshots. The engine examples require no UI to run their tests.
