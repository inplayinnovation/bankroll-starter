# Bankroll Starter

A real-money app, running on your phone, in three commands.

```bash
npm create @joinbankroll/app@latest my-app
cd my-app
npm run dev
```

`npm run dev` prints a QR. Scan it: your app opens inside Bankroll, ready to take payments and pay them back out, hot reload included.

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
// Who you're dealing with, from a signed token rather than the client.
const { user, geo } = await requireSession(request);
user.identity; // a verified person — { age } when a date of birth is on file
geo;           // "US-NY" — where they are right now

// Charge them. They approve it in Bankroll.
const signature = await bankroll.charge({ amountCents: 500 });

// Pay them.
await pay({ to: user.wallet, amountCents: 2500 });
```

An app built in Bankroll's in-app builder runs on a **server wallet** instead:
a wallet Bankroll created for it, owned by its creator, that the app pays out
of with its own key through Bankroll (`src/lib/treasury.ts` explains the
variables). Money can also land in a wallet you hold no key for: set
`BANKROLL_PAYEE` to its address alone, and the app takes payments and cannot
pay out. And `npm run check` drives the app in a headless browser with a
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

Everything that is not your app comes from [`@joinbankroll/sdk`](https://www.npmjs.com/package/@joinbankroll/sdk) and [`@joinbankroll/cli`](https://www.npmjs.com/package/@joinbankroll/cli), so it updates with `npm update` rather than a merge.

## Make it yours

What ships is a skeleton, not a product: the session Bankroll signs — wallet, identity, location, age — can be verified on your server, the money path is wired, and the surface is empty. Build rounds of golf, contest entries, tips, loot boxes — whatever you're making. Open the project in Claude Code, Cursor, or Codex and ask:

> Set up this Bankroll app so it can take payments.

[`AGENTS.md`](./AGENTS.md) has what your agent needs: the routes, the rules money code has to follow, and how to deploy it.

## Shared app UI

The `/app` shell keeps content inside the phone's safe area. Its header shows
the user's Bankroll balance at the top right. Replace
[`home.tsx`](./src/app/app/home.tsx) to build your surface; the header stays.
The public site has its own layout.

[`BankrollBalances`](./src/components/bankroll-balances.tsx) reads
[`bankroll.balances()`](https://docs.joinbankroll.com/build/balances) from the
host and refreshes while the app is visible. Cash and app credits form one
Bankroll dollar balance; declared tokens have their own named balances.
This is a display, never an authorization check; charges and payouts still use
the server's money path. A host without this prerelease capability shows an
update hint without blocking the app.

## Templates

Every branch of this repo is a template — `main` is the skeleton, and each
branch is a reference app built on it. Scaffold one with:

```bash
npm create @joinbankroll/app@latest my-app -- --template demo
```

- [`demo`](../../tree/demo) — the money loop on one screen: the signed
  session's claims, a one-cent charge, and the payout that returns it.

## Links

[Docs](https://docs.joinbankroll.com/build/overview) · [Quickstart](https://docs.joinbankroll.com/build/quickstart) · [Payments](https://docs.joinbankroll.com/build/payments) · [Payouts](https://docs.joinbankroll.com/build/payouts) · [SDK](https://www.npmjs.com/package/@joinbankroll/sdk) · [CLI](https://www.npmjs.com/package/@joinbankroll/cli)

MIT — see [LICENSE](./LICENSE).
