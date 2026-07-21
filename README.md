# Bankroll Starter

A real-money app, running on your phone, in three commands.

```bash
npx create-next-app -e https://github.com/inplayinnovation/bankroll-starter my-app
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

It moves real mainnet HSUSD. Fund the treasury it generated with only what you want to risk.

## Make it yours

It sells a $1 loot box that pays $1 back — a deliberately trivial product, so the money loop and the store are what's on show. Sell rounds of golf, contest entries, tips — whatever you're building. Open the project in Claude Code, Cursor, or Codex and ask:

> Set up this Bankroll app so it can take payments.

[`AGENTS.md`](./AGENTS.md) has what your agent needs: the routes, the rules money code has to follow, and how to deploy it.

## Links

[Docs](https://docs.joinbankroll.com/build/overview) · [Quickstart](https://docs.joinbankroll.com/build/quickstart) · [Payments](https://docs.joinbankroll.com/build/payments) · [Payouts](https://docs.joinbankroll.com/build/payouts) · [SDK](https://www.npmjs.com/package/@joinbankroll/sdk)

MIT — see [LICENSE](./LICENSE).
