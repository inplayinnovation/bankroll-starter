# P2P engine

A headless engine for paid, asynchronous duels. Each player completes an
independent, bounded round; the game compares their results. Players may
start before an opponent arrives. The engine owns the complete player
lifecycle: Pay → Starting → gameplay → result. The app owns its rules and
screens.

The starter stays empty: no game singleton, player routes or example UI are
installed. This guide shows the binding to add when building an app.
[notes/p2p-engine.md](../../notes/p2p-engine.md) records the design;
[types.ts](./types.ts) defines the game and view types.

## One play operation

```ts
import { createP2PClient } from '../../engine/p2p/client';

const game = createP2PClient<GameView, Result>({ endpoint: '/api/game' });
await game.play();
```

The engine creates the entry, opens the Bankroll payment sheet, waits for
verified confirmation and starts the round automatically. One `starting`
phase covers that whole operation. A successful call returns a running or
completed round. An opponent is not required to start.

The client supplies payment and command identities, handles delayed webhooks,
and resumes the same operation after a lost response. Its player views do
not expose a payment request, a manual start permission or a cancellation
permission. The app has no lifecycle sequence to assemble.

Approving payment commits the player to the game. The player can dismiss the
host's payment sheet before approval. There is no voluntary entry-cancellation
API, including while a paid receipt is still in transit; the server enforces
this. Queue expiry and other automatic refund rules still apply. Navigating
away or disposing the client does not cancel a paid entry.

Browser entry points are `engine/p2p/client`, `engine/p2p/react` and
`engine/p2p/game`. The `engine/p2p` entry point is for server configuration.

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

Use the standard handler for `src/app/api/game/route.ts`:

```ts
import { getSession } from '@joinbankroll/sdk/next';
import { createP2PHandler, EngineError } from '../../../../engine/p2p';
import { duel } from '@/lib/duel';
import { paidPlayRestriction } from '@/lib/restrictions';

export const runtime = 'nodejs';
export const POST = createP2PHandler({
  engine: duel,
  async authenticate(request) {
    const session = await getSession(request);
    if (!session?.user.identity) return null;
    if (paidPlayRestriction(session).reason)
      throw new EngineError('forbidden', 'Paid play is not available to you.');
    return { wallet: session.user.wallet };
  },
});
```

The callback verifies the session and the app's player eligibility. Its wallet
comes from that session, never from a request body. The engine dispatches its
own protocol; the app does not write an operation switch or individual
payment, start, and cancellation routes. Browser requests carry the player's
session through the engine's built-in `bankrollFetch` transport.

`BANKROLL_RESTRICTIONS` is a JSON policy of countries, regions and minimum
ages (https://docs.joinbankroll.com/build/restrictions). With a policy, a
missing region is refused wherever the policy needs one, and so is a session
with no verified age. `/api/me` returns `restriction` for UI feedback; server
authentication enforces the same decision on player requests. The webhook
remains independent of this check.

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

## Connect the UI

Create one client for the app's active surface or provider and subscribe to
its snapshot. In a React component:

```tsx
'use client';

import { useState } from 'react';
import { createP2PClient } from '../../../engine/p2p/client';
import { useP2PGame } from '../../../engine/p2p/react';
import type { WordsResult, WordsView } from '../../../engine/p2p/examples/words';

// Inside the component:
const [game] = useState(() =>
  createP2PClient<WordsView, WordsResult>({ endpoint: '/api/game' }),
);
const { phase, round, error } = useP2PGame(game);
```

Render from `phase`:

| Phase | Screen behavior |
| --- | --- |
| `idle` | Show Play; its action calls `game.play()` |
| `starting` | Show “Starting…” while the engine completes payment and admission |
| `playing` | Render `round.game`; send player input through `game.act(action)` when `round.canAct` |
| `finished` | Render the result, opponent wait or automatic refund from `round` |
| `error` | Render `error.message`; `game.resume()` retries the retained workflow |

Workflow failures are reflected in the snapshot. Handle rejected promises in
UI event handlers; the snapshot supplies the state to render.
The UI has one Play action. It does not inspect receipt state, open its own
payment sheet or add another Start button.

| Client method | Purpose |
| --- | --- |
| `play({ offerId? })` | Pay and automatically start; concurrent calls share the active operation |
| `resume(roundId?)` | Reconnect to a selected round or restore the retained operation |
| `act(action)` | Submit a game input with the engine's command identity and sequence |
| `get(roundId)` | Read a safe player view without changing the round |
| `history({ cursor?, limit? })` | Read a page of safe player views |
| `subscribe(listener)` / `getSnapshot()` | Observe state without React |
| `dispose()` | Stop this client's local work; never cancel a paid entry |

Use `resume(roundId)` when opening a round deep link; use `resume()` when
restoring the current tab's retained operation. The default browser
persistence is session storage, scoped by endpoint. Keep a round ID in the
URL for navigation. A network failure or ambiguous payment response retains
the same intent and charge key. Reconnecting continues that intent rather
than creating another entry or restarting the clock.

The React hook subscribes only. It does not dispose a shared client when a
component unsubscribes. Keep the client alive across game screens. Call
`dispose()` when permanently retiring its owner; create a new client before
using it again. Do not put permanent disposal in a React effect cleanup that
will be followed by React's development setup cycle.

The server fixes the clock when the automatic start commits. A disconnected
player is still committed, but a payment webhook does not start an unseen
clock. The existing queue and no-show rules cover players who never reconnect.
Reads remain read-only; the browser is not responsible for settlement.

A player view includes its permitted `game`, `result`, deadlines, match
`outcome`, and independent `payout` status. A pending payout does not hide or
change the established result. Automatic closure is distinguishable from a
completed game; no view presents it as a voluntary cancellation action.

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
