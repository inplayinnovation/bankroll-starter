# Word Hunt — free play

A Bankroll reference app: find words on a seeded 4×4 board in 60 seconds.
The server owns the round and score. No payments or payouts occur.

```bash
npm install
npm run dev
```

The dev command prints a QR that opens the app inside Bankroll, with hot reload.
See [AGENTS.md](./AGENTS.md) for setup, testing, and deployment.

## Read the implementation

| File | What it demonstrates |
| --- | --- |
| [home.tsx](./src/app/app/home.tsx) | Home, Play/Results tabs, help, and game deep links |
| [game-screen.tsx](./src/app/app/game-screen.tsx) | A game that fits its frame and opens its result when finished |
| [games.ts](./src/lib/games.ts) | One document per round, compare-and-swap, replay, and server deadlines |
| [game routes](./src/app/api/games/route.ts) | Wallet scope from the verified session |
| [client/games.ts](./src/lib/client/games.ts) | Recovering a round and retrying the same submission |
| [word-hunt.ts](./src/lib/word-hunt.ts) | Path validation, scoring rules, and response types |
| [games.test.ts](./test/games.test.ts) | Races, expiry, replay, ownership, and history pagination |

The shared layout conventions are in [anatomy.md](./anatomy.md). Home has the
balance, help, a play option, and a Play CTA. Gameplay and the individual result
use the full frame. Results history scrolls above the pinned footer tabs.

## Round lifecycle

`ready → playing → finished`

Play prepares a round, saves its ID in the URL, and starts it. The server mints
the seed, keeps the board hidden until start, and fixes the deadline. Reloading
or retrying a start keeps that deadline. Both finishing early and expiring are
terminal transitions.

Each submission contains only a sequence and tile path. The server derives the
word, validates it, and records any points in the same document as the sequence.
Duplicate requests return current state. Neither score nor elapsed time comes
from the client. Expired rounds finish on their next read or action, including
when opening history after closing the app.

The English dictionary is the pinned
[`an-array-of-english-words`](https://github.com/words/an-array-of-english-words)
package (MIT, derived from the Letterpress word list). It stays on the server.
The generator, scoring, and dictionary form rules version 1.

This validates legal play and scores. It does not detect a solver or someone
automating legal submissions.

## Check it

```bash
npm run typecheck && npm run lint && npm test
# With BANKROLL_MOCK=1 on the dev server:
npm run check -- /app '/app?tab=results' '/app?help=1'
```

The test suite uses isolated storage. `STORE=blob npm test` uses the throwaway
Blob credentials described in AGENTS.md. Do not run a second Next dev server
when a tunnel server is already running for this project.

## Templates

- `main` — the app skeleton: entry gates, verified session, shared UI, and adapters.
- `f2p` — this free Word Hunt reference game.

Published templates can be scaffolded with:

```bash
npm create @joinbankroll/app@latest my-app -- --template f2p
```

MIT — see [LICENSE](./LICENSE).
