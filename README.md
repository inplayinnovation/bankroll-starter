# Bankroll Starter

A Bankroll app skeleton, running on your phone, in three commands.

```bash
npm create @joinbankroll/app@latest my-app
cd my-app
npm run dev
```

`npm run dev` prints a QR. Scan it: your app opens inside Bankroll, with hot reload.

No account. No signup. No API key. Nothing to register.

Building with a coding agent? Start at
[Build with an agent](https://docs.joinbankroll.com/build/agents) — it walks
the whole setup, from an empty folder to the QR on your phone.

## The hard parts are already done

**Payments.** Stablecoin transfers that settle on-chain and are final. No processor, no merchant account, no chargebacks, no payout rail to build.

**Identity.** Every user is a verified real person, and one person verifies exactly one identity. Multi-accounting doesn't work.

**Location.** Where the user is for this session, so you can decide where you operate.

All three arrive with the user. You write the product.

```ts
import { requireSession } from '@joinbankroll/sdk/next';

// Who you're dealing with, from a signed token rather than the client.
const { user, geo } = await requireSession(request);
user.identity; // a verified person — { age } when a date of birth is on file
geo;           // "US-NY" — where they are right now
```

An app built in Bankroll's in-app builder runs on a **server wallet** instead:
a wallet Bankroll created for it, owned by its creator, that the app pays out
of with its own key through Bankroll (`src/lib/treasury.ts` explains the
variables). And `npm run check` drives the app in a headless browser with a
stand-in host, so a coding agent or CI can test it without a phone.

It moves real mainnet HSUSD. `npm run dev` creates a signing key at `~/.config/bankroll/keypair.json` on first use and hands it to the dev server — it is never written into your project, so it cannot be committed. That key receives payments and signs payouts, so fund it with only what you want to risk, and give a deployment its own.

## Commands

```bash
npm run dev                                     # tunnel + QR — the loop you're in
npx bankroll treasury                           # the wallet this app runs on
npx bankroll token create --name "Promo Credit" # a token of your own
npx bankroll --help                             # everything else
```

`npm run dev` is `bankroll dev`, because the app only runs inside Bankroll — a
plain localhost server is the exception, not the loop, and it is `npx next dev`
when you want it.

`npx bankroll token create --name "Promo Credit"` mints your own token: play money that spends in your app and nowhere else, so you can exercise the whole money loop without spending real money. It lands in [`app-tokens.json`](./app-tokens.json), which is the `appTokens` claim your manifest serves.

Platform primitives come from [`@joinbankroll/sdk`](https://www.npmjs.com/package/@joinbankroll/sdk) and [`@joinbankroll/cli`](https://www.npmjs.com/package/@joinbankroll/cli), and update with `npm update`. The local game engine described below is kept separate from app code for future SDK extraction.

## Make it yours

The skeleton includes the manifest, entry gates, a verified-session endpoint,
a balance component, and storage and treasury adapters. Build your screens,
state, and payment flows on top of those pieces. Open the project in Claude
Code, Cursor, or Codex and ask:

> Set up this Bankroll app so it can take payments.

[`AGENTS.md`](./AGENTS.md) covers the project structure, development checks,
and deployment. The `demo` template below has a working payment flow.

## Shared app UI

The `/app` shell fills the phone's viewport and keeps content inside its safe
area. The default [`home.tsx`](./src/app/app/home.tsx) uses
[`TabbedScreen`](./src/components/tabbed-screen.tsx) for a balance header and
pinned Play/Results footer, with default icons. Tabs follow the URL; history
scrolls within the content area. Render gameplay and individual game results
separately to use the full frame. Replace `home.tsx` to build your screens;
[anatomy.md](./anatomy.md) describes the suggested layout and flow. The public
site has its own layout.

[`BankrollBalances`](./src/components/bankroll-balances.tsx) reads
[`bankroll.balances()`](https://docs.joinbankroll.com/build/balances) from the
host and refreshes while the app is visible. Cash and app credits form one
Bankroll dollar balance; declared tokens have their own named balances.
This is a display, never an authorization check. Payment decisions belong on
the server. A host without this prerelease capability shows an update hint
without blocking the app.

## P2P game engine

[`engine/p2p`](./engine/p2p/README.md) runs paid, asynchronous duels: each
player completes an independent round, and the game compares their results.
It owns entry payments, matchmaking, cancellation, deadlines and settlement.
Apps supply pure game rules and their own screens. A player can play before
an opponent arrives.

The [word game](./engine/p2p/examples/words.ts) demonstrates streamed tile
paths; the [shooting game](./engine/p2p/examples/shooting.ts) validates a
locally simulated replay. Neither is wired into the starter's empty surface.
Follow the [engine integration guide](./engine/p2p/README.md) when adding a
game; the app no longer assembles this lifecycle from a recipe.

[Timed actions and latency](./recipes/latency.md) explains input timing and
submission windows. [notes/p2p-engine.md](./notes/p2p-engine.md) records the
engine's design and failure behavior.

## Templates

Every branch of this repo is a template — `main` is the skeleton, and each
branch is a reference app built on it. Scaffold one with:

```bash
npm create @joinbankroll/app@latest my-app -- --template demo
```

- [`demo`](../../tree/demo) — the verified session, a one-cent charge, and
  paying the same cent back on one screen.

## Links

[Docs](https://docs.joinbankroll.com/build/overview) · [Quickstart](https://docs.joinbankroll.com/build/quickstart) · [Payments](https://docs.joinbankroll.com/build/payments) · [Payouts](https://docs.joinbankroll.com/build/payouts) · [SDK](https://www.npmjs.com/package/@joinbankroll/sdk) · [CLI](https://www.npmjs.com/package/@joinbankroll/cli)

MIT — see [LICENSE](./LICENSE).
