# Bankroll Starter

A real-money app, running on your phone, in three commands.

```bash
npm create @joinbankroll/app@latest my-app
cd my-app
npm run bankroll
```

Scan the QR it prints. Your app opens inside Bankroll and starts taking payments and paying them back out, hot reload included.

No account. No signup. No API key. Nothing to register.

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

It moves real mainnet HSUSD. `npm run bankroll` creates a signing key at `~/.config/bankroll/keypair.json` on first use and hands it to the dev server — it is never written into your project, so it cannot be committed. That key receives payments and signs payouts, so fund it with only what you want to risk, and give a deployment its own.

## Commands

```bash
npm run bankroll   # dev server behind a public tunnel, and a QR to open it
npm run dev        # just the dev server, no tunnel
npm run token      # the tokens this app declares
npm run treasury   # the wallet this app runs on, and what it holds
```

`npm run bankroll` is `bankroll dev`, so it takes no subcommand of its own —
reach anything else with `npx bankroll <command>`, or pass flags after `--`
(`npm run token -- create --name "Promo Credit"`).

`npm run token -- create --name "Promo Credit"` mints your own token: play money that spends in your app and nowhere else, so you can exercise the whole money loop without spending real money. It lands in [`app-tokens.json`](./app-tokens.json), which is the `appTokens` claim your manifest serves.

Everything that is not your app comes from [`@joinbankroll/sdk`](https://www.npmjs.com/package/@joinbankroll/sdk) and [`@joinbankroll/cli`](https://www.npmjs.com/package/@joinbankroll/cli), so it updates with `npm update` rather than a merge.

## Make it yours

It sells a $1 loot box that pays $1 back — a deliberately trivial product, so the money loop and the store are what's on show. Sell rounds of golf, contest entries, tips — whatever you're building. Open the project in Claude Code, Cursor, or Codex and ask:

> Set up this Bankroll app so it can take payments.

[`AGENTS.md`](./AGENTS.md) has what your agent needs: the routes, the rules money code has to follow, and how to deploy it.

## Links

[Docs](https://docs.joinbankroll.com/build/overview) · [Quickstart](https://docs.joinbankroll.com/build/quickstart) · [Payments](https://docs.joinbankroll.com/build/payments) · [Payouts](https://docs.joinbankroll.com/build/payouts) · [SDK](https://www.npmjs.com/package/@joinbankroll/sdk) · [CLI](https://www.npmjs.com/package/@joinbankroll/cli)

MIT — see [LICENSE](./LICENSE).
