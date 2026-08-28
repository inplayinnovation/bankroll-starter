# Bankroll Starter

Next.js 16 (App Router) + React 19 + TypeScript + Tailwind v4. A real-money app
for the Bankroll platform: it sells things and pays users out. It is **not** a
wallet — the Bankroll host holds the money, identity, and location; this app
takes payments and remembers what was bought.

Platform docs: https://docs.joinbankroll.com/llms-full.txt

## Commands

```bash
npm run dev            # bankroll dev — tunnel + QR that opens the app on a phone
npx bankroll --help    # treasury, token, and anything else
npx next dev           # plain localhost, no tunnel — the exception
npm run build          # next build
npm test               # vitest run
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
```

Run `npm run typecheck && npm run lint` before finishing any change.

`STORE=blob npm test` runs the same suite against Vercel Blob rather than local
files, using `DANGEROUS_BLOB_TOKEN` from `.env.test.local`. The store backends
themselves are the SDK's, and their cross-backend contract is tested there.
`test/environment.test.ts` asserts the suite is isolated from your dev store and
from any real Blob store; if it fails, stop rather than let a fixture delete
real data.

## Setup (local)

**Local development needs nothing.** `npm create @joinbankroll/app` writes
`.env.local` — `STORE=fs`, the app name, and an RPC. `npm run dev` takes it from
there: a tunnel, and a QR that opens the app on a phone.

The key that receives payments and signs payouts lives at
`~/.config/bankroll/keypair.json`, created on first use and injected into the
dev server rather than written into the project, so it cannot be committed. It
moves real mainnet HSUSD — fund it with only what you need to test.

The tunnel gets a **new URL on every restart**, so the host can't reopen a
previous one: scan the new QR after each start. "Can't open this app" almost
always means a dead tunnel.

If you are an agent: run `npm run dev` as a background task — its output, the
QR included, is never shown to the user. Put the QR **in your chat reply** as
plain monospace glyphs in a fenced code block, the play link under it;
`bankroll dev` prints exactly that when stdout is not a TTY (CLI 0.3+, and
https://docs.joinbankroll.com/build/agents.md carries the rebuild recipe for
older CLIs). Never relay the ANSI QR from a TTY run — its contrast is in the
color codes, so chat strips it to a wall of `▀` — and never send the QR as an
image file or attachment; neither renders in a terminal chat.

## Structure

`/` is the landing page — the public site whose job is the "Open on Bankroll"
link. `/app` is the app itself, what the host loads. Keep the split: a real app
has a site and an app, and the manifest is served from the origin either way.

Three conventions that split implies:

- **The site is desktop, the app is a phone.** Give each its own layout shell
  (the site frames itself full-width; `/app` gets the narrow safe-area shell)
  and keep the root layout bare, so neither inherits the other's frame — and
  don't share CSS class names between them.
- **The app never links back to the site.** The site exists to hand a visitor
  into Bankroll; a logo inside the app is a label, not a link, because tapping
  it would drop a player out of their session for a page that only sends them
  back.
- **Put in-app navigation in the URL.** Anything a player perceives as a place
  — a tab, a history screen — belongs in the query string, so links can be
  shared and the back button works: sync tabs with `replaceState` (switching
  tabs shouldn't pile up back entries), open overlay screens with `pushState`
  so back closes them, and let deep links (an invite) win over the default
  view on load.

What ships is a demo rather than a product: it displays the session claims, then
charges a cent and pays the same cent back so both directions of the money loop are
visible. Replacing it with the thing you're actually selling is expected — the
money-path rules below are what carries over.

- `src/app/demo.tsx` — the app's surface. Delete it and render your own from
  `/app`, which stays a thin shell. It is not a wallet: the host is.
- `src/app/api/charges/` — the money. `route.ts` takes a charge and lists them;
  `intent/` starts one; `[id]/payout` pays one back out.
- `src/lib/charges.ts` — the price, and the checks a settled payment must pass.
  Both the live path and the sweep go through it, so they cannot drift apart.
- `src/lib/sweep.ts` — finding charges that settled but were never reported.
- `src/lib/store.ts` — this app's durable state; see Storage.
- `src/lib/app-identity.ts` — how the app introduces itself in the manifest:
  its name, where it boots, the tokens it issues, and `BANKROLL_SUPPORT_URL`,
  which puts a "Help with <app>" item in Bankroll's own menu. Any URL works —
  a help page, `mailto:`, `tel:`, a chat invite — and it opens outside the app.
  Changing it later re-asks every existing user for consent, so point it at
  something durable.

Everything that is not this app comes from `@joinbankroll/sdk` and updates with
`npm update` rather than being edited here: sessions, origin, and the manifest
route from `/next`; the treasury, charge confirmation, and payouts from
`/server`; the store backends from `/store`; the dev overlay and host hooks from
`/react`.

## Money-path rules

**0. Every fact about the user comes from the verified session.** `wallet`,
`username`, `identity`, `geo`, `age` are read server-side from the signed token
(`requireSession` → `verifyToken`, audience pinned to this origin). The client
bridge exposes no user data — only `status()`, `charge()`, `session()` (a token,
not a profile). Never take any of these from a request body.

**1. Server computes amounts.** The price is a server constant, never the
request body. The payer is the verified session, never a client field.

**2. Check payee, amount, and payer before releasing value.**

```ts
const charge = await confirmCharge(signature);
if (charge.payee !== treasury.address) return reject();   // never skip this one
if (charge.amountCents !== PRICE_CENTS) return reject();
if (charge.payer !== session.user.wallet) return reject();
```

Skipping the payee check is the common, expensive bug: a transfer the user sent
to their own second wallet passes the other two.

**3. One atomic write both records the charge and guards the replay.** The id
is derived from the transaction (`sortableId(charge.slot, signature)`), so a second
attempt computes the same id and the create fails — there is no separate "spend
the signature" step to leave half-finished.

```ts
const { created, charge } = await recordCharge(wallet, signature, slot, amountCents, mint);
// created === false means a retry or replay — already satisfied, not an error.
```

**4. The payout runs on the charge's own document.** The whole payout lifecycle
is compare-and-swap on one key, so nothing spans two documents. The order is
build → sign → **store** → send → confirm: the `held → paying` transition
records the transaction's *signature* and expiry (signing is deterministic, so
the id exists before anything is broadcast), and only then is it sent. A stuck
`paying` charge is resolved by `confirmPayout(stored signature)` — never by
resending, whose rejection can't say whether an earlier submission landed.
`expired` is ledger-searched proof the attempt never landed and never can; it
is the only outcome that licenses building a fresh transaction, so a second
payout for the same charge cannot exist while the first might still be live.
On any other `PayError` the charge stays `paying` — ask again later.

**5. Write down what you are about to charge, before you charge it.** `charge()`
gives the signature to the page, and the page gives it to you. If the page dies
in between — app killed, connection dropped, battery flat — the payment still
settled, and nothing you hold points to it. So the server mints a `reference`
first and stores it with the attempt; the payment carries it on-chain, and the
charge stays findable by an id that existed before it did.

```ts
const intent = await recordIntent(wallet, createReference(), crypto.randomUUID(), PRICE_CENTS);
// the page passes intent.reference and intent.paymentKey to charge()
const charge = await findChargeByReference(intent.reference);   // later, if it never reported
```

Mint both server-side. A reference the page invents is one the page can lose,
reuse, or forget to send, and the same is true of the key that stops a retry
charging twice.

A found charge is a candidate, not a receipt. A reference is public once it
lands, so anyone can attach it to a transfer of their own — run rule 2's checks
on it exactly as you would on one the page reported, which is why both paths
call the same `settle()`.

Recovery costs nothing extra to make safe: the charge id still comes from the
transaction, so a sweep that finds a payment computes the same id as the live
path and rule 3's atomic create collapses them. No lock, no "being recovered"
state.

**Sweep on whether an attempt was answered, never on how old it is.** Age says
when a payment can still *arrive* — a transaction cannot land once its blockhash
has died. It says nothing about whether one already arrived while nobody was
watching, which is the entire case this exists for. Someone who pays, loses the
page, and comes back an hour later must still be recovered. Age decides only
when a chain that has never heard of an attempt turns "not yet" into "never", at
which point the attempt is closed as `unpaid` and never asked about again.

Two limits worth knowing before you build on this:

- **One intent per attempt, keyed under the wallet.** Keeping only a wallet's
  latest attempt would erase an unresolved one the moment the user tried again —
  losing the reference for a payment that had already settled. If you sell more
  than one thing, key intents per *order* rather than per attempt and carry the
  order id on the document.
- **`findChargeByReference` returns one candidate**, the oldest transfer
  carrying the reference that parses as a payment. A transaction carrying your
  reference that lands *first* therefore hides the real charge. It takes someone
  who knows the reference and is willing to spend real money, but there is no
  way to recover from it in the app — treat a reference as something to keep out
  of logs and URLs.

**Refuse rather than charge without a reference.** Passing one needs a Bankroll
app new enough to carry it, and the SDK rejects `update_required` on anything
older. Ask for the update. Silently charging without a reference is exactly the
payment you cannot find later.

## Storage

`src/lib/store.ts` — this app's Charge model. The backends behind it are
`@joinbankroll/sdk/store/fs` and `/store/vercel`: local files in development,
Vercel Blob when deployed, chosen by `STORE`. Nothing above the interface knows
which is live, so the same code deploys unchanged.

- `createIfAbsent()` — atomic create that fails if the path exists (rule 3's guard)
- `writeJson(..., ifMatch)` — compare-and-swap, throws `PreconditionFailed` on a
  lost race (rule 4's transitions)
- `list(prefix, { limit, cursor })` — a page in ascending key order; charges key
  the slot first so a listing is newest-first without a post-sort
- Blob reads pass `useCache: false`, or they can be 60s stale

One document per charge at `charges/<wallet>/<invertedSlot>-<signature>.json` —
no aggregate to keep in sync, which is what makes it safe on a store with no
transactions. Outgrow it → replace `store/` with Postgres; don't add query
capability the object store can't back (filter with your own index).

Alongside it, one per attempt at
`intents/<wallet>/<invertedStartedAt>-<reference>.json` (rule 5). Not
authoritative — the charge document is, and it is still keyed by the transaction
— so an intent is only a note to go and look. Nested under the wallet on purpose:
listing one level below a prefix behaves the same on both backends, while a
listing across *all* wallets does not (Blob's is recursive, the filesystem's is
one directory deep), so a global reconcile is deployment-only work.

## Deploy

To your own Vercel — never hosted by Bankroll. `.env.local` is gitignored, so
`STORE=fs` and the dev treasury never reach the deployment; with no `STORE`,
production uses Blob.

```bash
npx vercel link                                    # create/connect the project
npx vercel blob create-store <name>                # injects BLOB_READ_WRITE_TOKEN into the deploy
npx vercel env add BANKROLL_APP_NAME production     # --value <name>, or stdin
npx vercel deploy --prod
```

Connecting the Blob store injects its token into the deployment automatically —
do **not** `vercel env pull` it into `.env.local` (that overwrites your dev
setup). `vercel env add <KEY> <env>` targets one environment, `--force`
overwrites; Production/Preview vars are sensitive by default (unreadable after),
Development rejects sensitive values. Users open the app at
`https://joinbankroll.com/play?url=<url-encoded origin>/app`.

### The production treasury key

Generate a **fresh** key for production — never the dev key, which sits in
plaintext on the machine — and set it so it is never printed or written to disk:
generate it and pipe straight into a sensitive variable.

```bash
# writes the secret to stdout (piped, never shown) and the public address to
# stderr (shown, so you know which wallet to fund)
node -e "const{generateKeyPairSync}=require('crypto'),bs58=require('bs58').default;const{publicKey,privateKey}=generateKeyPairSync('ed25519');const a=publicKey.export({format:'der',type:'spki'}).subarray(-32),s=privateKey.export({format:'der',type:'pkcs8'}).subarray(-32);console.error('treasury:',bs58.encode(a));process.stdout.write(bs58.encode(Buffer.concat([s,a])))" \
  | npx vercel env add BANKROLL_TREASURY_KEY production --sensitive
```

## STOP: never replace a funded treasury

If `BANKROLL_TREASURY_KEY` is already set (`npx vercel env ls`), do not replace
it without asking — swapping the variable strands the balance, it does not move
it. Replacing a funded treasury means: create the new key, move the old wallet's
entire balance to the new address, then swap. A sensitive variable's value is
shown once, at creation, never again.

## Do not edit

`src/app/.well-known/bankroll.jwt/route.ts` — the manifest derives origin,
payment address, name, and icon at runtime. Serving it is what makes this a
Bankroll app; there is no registration step and no signing key.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
