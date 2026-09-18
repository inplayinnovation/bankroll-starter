# Bankroll Starter

Next.js 16 (App Router) + React 19 + TypeScript + Tailwind v4. A skeleton for
Bankroll apps. The host holds the player's wallet and provides identity and
location. Build your screens, state, and payment flows here.

Platform docs: https://docs.joinbankroll.com/llms-full.txt

[anatomy.md](./anatomy.md) describes the suggested screen layout and flow:
Home, Results, gameplay, and each game's result.

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

## Testing without a phone

```bash
BANKROLL_MOCK=1 npx next dev      # or put BANKROLL_MOCK=1 in .env.local
npm run check -- /app             # headless phone-sized Chromium, fake host
npm run check -- /app '/app?tab=results' / # both tabs and the public site
npm run check -- --admin-probe    # only the player probe of /api/admin (also runs after every check)
```

`npm run check` loads each path with `@joinbankroll/sdk/mock`'s stand-in host
injected, so the client SDK reports `ready`, `session()` answers as `@tester`
with a verified identity, and `charge()` completes with a made-up signature the
server accepts. It fails on any console error, page error, or failed request,
and writes screenshots to `checks/`. Look at them. Real money moves only inside
the Bankroll app; the flag is ignored in production builds.

Pass `--owner` to test screens you add for the app's owner.

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

The skeleton supplies entry gates, a verified-session endpoint, balance and
tabbed-screen components, and storage and treasury adapters. The surface shows
the balance and Play/Results tabs with empty content.

- `src/app/app/home.tsx` — the app's surface, including its header and
  navigation. This is the file you replace.
- `src/app/app/layout.tsx` — the phone shell and its viewport configuration.
  The root layout stays bare; the public site supplies its own frame.
- `src/app/app/gate.tsx` — the entry gates: hydration, configuration, host
  status. Every surface renders inside them; `page.tsx` stays a thin shell
  that renders the surface inside those gates. Leave both alone when replacing
  the surface.
- `src/components/bankroll-balances.tsx` — the host balance display at the top
  right, backed by `src/lib/client/balances.ts`.
- `src/components/tabbed-screen.tsx` — the header, content area, and pinned
  footer navigation. `home.tsx` shows how to configure its tabs.
- `src/app/api/me/route.ts` — claims from the verified session, plus app
  configuration. `useMe()` in `src/lib/client/bankroll.ts` reads them.
- `src/lib/store.ts` — the store backend this app writes documents to; see
  Storage.
- `src/lib/p2p/` — reusable paid two-player entries, matchmaking and settlement.
- `src/app/api/cron/reconcile/route.ts` — authenticated scheduler binding for a game.
- `src/lib/treasury.ts` — the payee, owner, and payout signer configuration.
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

## Recipes

| Mode | Recipe | Module |
| --- | --- | --- |
| p2p | [recipes/p2p.md](./recipes/p2p.md) | [src/lib/p2p/](./src/lib/p2p/) |

The f2p and p2e recipes follow when their modules exist.

## Shared app UI

**Apply safe-area padding once, on the app shell.** `/app` exports
`viewportFit: 'cover'`; `.app-shell` in `src/app/globals.css` uses
`env(safe-area-inset-*)` to keep content clear of the notch, status bar, and
home indicator. Padding is the larger of the device inset and the normal
spacing (2.5rem top, 0.75rem bottom, 1.25rem horizontally). Keep the header and
surface inside that shell without adding a second inset. A phone-sized browser viewport
alone does not simulate a notch; check on a device or override the browser's
safe-area insets when checking layout.

**The surface owns its header.** `home.tsx` renders `BankrollBalances` at the
top right inside `Gate`. Keeping the header with the surface lets gameplay
hide it. Reuse `BankrollBalances` for its host reads and formatting.

**Keep footer tabs outside scrolling content.** The app shell fills the dynamic
viewport height. `TabbedScreen` reserves space for its header and footer and
gives the remaining height to the selected tab. Set `scroll: true` for history;
the footer stays visible. The first tab is the default, `?tab=<id>` selects
another, and switching uses `replaceState` while preserving other query params.
The `play` and `results` tab IDs have default icons; `icon` supplies a custom one.
Render gameplay and individual game results outside `TabbedScreen`; let their
deep links take precedence when choosing the surface.

**Host balances are for display only.** `useBalances()` calls
[`bankroll.balances()`](https://docs.joinbankroll.com/build/balances) on mount,
every two seconds while visible, and when the page regains focus or visibility.
The host reads its own live balance store; the app does not query a wallet or
derive a balance from charges. Cash and app credits arrive in cents: add
`cashCents + creditsCents` and display them as one Bankroll dollar balance.
Token amounts arrive in whole tokens with up to nine decimal places; show
those separately using the names the host supplies from the manifest.
Declared tokens remain visible even at zero.

Loading and failed reads never display a made-up zero. A failed refresh clears
the old amount and retries on the next refresh. `balances()` is a prerelease
SDK capability: an older host may answer `update_required` even when sessions
work. The header shows an update hint and the rest of the app keeps working.
Never authorize play, price an order, or release value against this client
display; settled charges and server records remain authoritative.

## Storage

`src/lib/store.ts` selects the SDK backend: `@joinbankroll/sdk/store/fs` when
`STORE=fs`, otherwise `/store/vercel`. `storeBackend()` exposes that backend.
Define document shapes and keys alongside the app's domain logic.

The SDK supplies atomic creates, compare-and-swap writes, and paginated
listing. Keep each state transition within one document; the store has no
transactions across documents.

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

Reusing the dev key — `~/.config/bankroll/keypair.json` — is fine to get
production started: dev and production become one treasury wallet, funded
once. It is not a long-term setup. For real production use, either generate a
fresh keypair and custody a copy of the secret securely (a sensitive variable
cannot be read back, so that copy is the only recovery), or hold the treasury
key in a service built for it, like Privy or Turnkey. Either command below
writes the secret to stdout (piped, never shown) and the public address to
stderr (shown, so you know which wallet to fund).

```bash
# get started: reuse the dev treasury
node -e "const bs58=require('bs58').default,{readFileSync}=require('fs'),{homedir}=require('os');const k=Uint8Array.from(JSON.parse(readFileSync(homedir()+'/.config/bankroll/keypair.json','utf8')));console.error('treasury:',bs58.encode(k.subarray(32)));process.stdout.write(bs58.encode(k))" \
  | npx vercel env add BANKROLL_TREASURY_KEY production --sensitive

# or generate a fresh production key
node -e "const{generateKeyPairSync}=require('crypto'),bs58=require('bs58').default;const{publicKey,privateKey}=generateKeyPairSync('ed25519');const a=publicKey.export({format:'der',type:'spki'}).subarray(-32),s=privateKey.export({format:'der',type:'pkcs8'}).subarray(-32);console.error('treasury:',bs58.encode(a));process.stdout.write(bs58.encode(Buffer.concat([s,a])))" \
  | npx vercel env add BANKROLL_TREASURY_KEY production --sensitive
```

### The RPC

`SOLANA_RPC_URL` can start unset — the SDK falls back to the public Solana
endpoint, which is rate-limited and shared. Before real traffic, set it to a
dedicated RPC (e.g. one from https://www.helius.dev):

```bash
npx vercel env add SOLANA_RPC_URL production
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
