# Bankroll Starter

Next.js 16 (App Router) + React 19 + TypeScript + Tailwind v4. A skeleton for
Bankroll apps. The host holds the player's wallet and provides identity and
location. Build your screens, state, and payment flows here.

Read the platform docs before you write a Bankroll SDK call, and go back to
them when unsure: https://docs.joinbankroll.com/llms-full.txt has every page
in one file; the index is https://docs.joinbankroll.com/llms.txt, and any page
is markdown with `.md` added to its address. The SDK is pre-1.0 and minor
versions carry breaking changes, so check the installed version against the
changelog page rather than writing calls from memory. In Bankroll's builder the
same file is at `../builder/bankroll-docs.md`.

[anatomy.md](./anatomy.md) describes the suggested screen layout and flow:
Home, Results, gameplay, and each game's result.

## How this app reaches Bankroll

Bankroll owns this app's deployment. **A commit that reaches this repo's
`main` is the deploy:** Bankroll reads the code, classifies what the app does
(free, paid, prizes; that sets where it may take money), signs its manifest,
and deploys it. A build takes a minute or two. The commit message is what the
owner reads as the run's text in their Bankroll app, so make it plain and
about the change.

Check `git remote -v` before you touch git:

- **A remote named `bankroll`** is a laptop clone. You push yourself:
  `git push bankroll main`. A failed build sends the owner a push
  notification. The Bankroll CLI shows the run's state, the app's address,
  and publishes the app; the `bankroll` skill teaches an agent all of it:
  `npx skills add inplayinnovation/bankroll-cli --skill bankroll -g`.
- **A remote named `origin`** is Bankroll's own builder. Do not commit or
  push: the builder commits and pushes when the run ends. Its rules file says
  what else is different there.

In both cases:

- Do not deploy this app yourself: no `vercel link`, no `vercel deploy`, and
  `vercel.json` keeps `git.deploymentEnabled: false`, so only Bankroll's build
  deploys a push.
- The deployment's wallet, manifest, webhook secret, and restrictions are
  settings Bankroll puts on the project. Nothing about money or keys goes in
  this repo.
- Never create or edit files under `.github/workflows`.

## Commands

```bash
npm run check -- /app  # the app in a headless phone with a stand-in host
npm run build          # next build
npm test               # vitest run
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npx next dev           # laptop: the dev server on localhost (see Run it on a laptop)
npm run dev            # laptop: bankroll dev — tunnel + QR that opens the app on a phone
git push bankroll main # laptop: Bankroll builds and deploys the app
```

Run `npm run typecheck && npm run lint && npm run build` before finishing any
change; a build that fails is not deployed.

`STORE=blob npm test` runs the same suite against Vercel Blob rather than local
files, using `DANGEROUS_BLOB_TOKEN` from `.env.test.local`. The store backends
themselves are the SDK's, and their cross-backend contract is tested there.
`test/environment.test.ts` asserts the suite is isolated from your dev store and
from any real Blob store; if it fails, stop rather than let a fixture delete
real data.

## Run it on a laptop

With the `origin` remote, Bankroll's builder, the dev server is already
running with the app's settings; skip this. On a laptop, look for
`.env.development` at the project root: Bankroll writes it when it creates
an app, with `STORE=fs`, `BANKROLL_MOCK=1`, and the app's name, payee, owner,
and wallet id, and `next dev` reads it. An older app has none; give it the
three settings that matter in `.env.local`:

```bash
cat > .env.local <<'EOF'
STORE=fs
BANKROLL_MOCK=1
BANKROLL_APP_NAME=<the app's name>
EOF
```

`STORE=fs` keeps documents in files under `bankroll/development/`; without it
the store is Vercel Blob, which needs a token the deployment has and your
machine does not. `BANKROLL_MOCK=1` makes the server accept a stand-in host:
its token, its made-up charge signatures, and simulated payouts, so no money
moves and no key is needed. Production builds ignore both files.

```bash
npx next dev                      # the dev server, on localhost
npm run check -- /app             # headless phone-sized Chromium, stand-in host
npm run check -- /app '/app?tab=results' / # both tabs and the public site
npm run check -- --admin-probe    # only the player probe of /api/admin (also runs after every check)
```

`npm run check` loads each path with `@joinbankroll/sdk/mock`'s stand-in host
injected, so the client SDK reports `ready`, `session()` answers as `@tester`
with a verified identity, and `charge()` completes with a made-up signature the
server accepts. It fails on any console error, page error, or failed request,
and writes screenshots to `checks/`. Look at them. Pass `--owner` to test
screens you add for the app's owner. Under `BANKROLL_MOCK=1` the app also
puts the stand-in host on its own page (`src/app/app/mock-host.tsx`), so
`http://localhost:3000/app` runs in any browser, yours or an agent's, as the
pretend user; without the flag a browser has no host and `/app` shows "Open
this in Bankroll".

**On a phone:** `npm run dev` runs the dev server behind a public tunnel and
prints a QR that opens the app inside Bankroll, with real sessions and real
charges. It supplies a signing key from `~/.config/bankroll/keypair.json` as
the payee, created on first use and never written into the project. Leave
`BANKROLL_MOCK` out of `.env.local` for that loop: with it set, charges are
real and payouts are simulated. The tunnel gets a **new URL on every
restart**, so the host can't reopen a previous one: scan the new QR after each
start. "Can't open this app" almost always means a dead tunnel.

If you are an agent: run `npm run dev` as a background task — its output, the
QR included, is never shown to the user. Put the QR **in your chat reply** as
plain monospace glyphs in a fenced code block, the play link under it;
`bankroll dev` prints exactly that when stdout is not a TTY, so re-print it
verbatim. Never relay the ANSI QR from a TTY run — its contrast is in the
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
- `src/lib/restrictions.ts` — `paidPlayRestriction(session)` evaluates
  `BANKROLL_RESTRICTIONS` against a verified session; `/api/me` exposes the
  decision as `restriction` for the UI.
- `engine/p2p/` — the headless P2P engine; its [README](./engine/p2p/README.md)
  documents `client.play()`, the game contract and standard server binding. Examples
  and tests live alongside it. The skeleton does not bind a game.
- `src/app/api/bankroll/webhook/route.ts` — where Bankroll reports references
  and deadlines; bind the configured engine's `webhook` handlers here.
- `src/lib/treasury.ts` — the payee, owner, and payout signer configuration.
- `src/lib/app-identity.ts` — how the app introduces itself in the manifest:
  its name, where it boots, the tokens it issues, and `BANKROLL_SUPPORT_URL`,
  which puts a "Help with <app>" item in Bankroll's own menu. Any URL works —
  a help page, `mailto:`, `tel:`, a chat invite — and it opens outside the app.
  Changing it later re-asks every existing user for consent, so point it at
  something durable.

Platform primitives come from `@joinbankroll/sdk` and update with
`npm update` rather than being edited here: sessions, origin, and the manifest
route from `/next`; the treasury, charge confirmation, and payouts from
`/server`; the store backends from `/store`; the host hooks from `/react`.

## P2P games

[engine/p2p/README.md](./engine/p2p/README.md) is the integration guide for
paid, asynchronous two-player games; [notes/p2p-engine.md](./notes/p2p-engine.md)
records the design. Keep the skeleton unbound until adding an app's game.
Game rules and UI use the engine's public API; the engine owns the lifecycle.
The client owns Pay → Starting → gameplay through `play()`, including payment
confirmation and automatic start. Bind `createP2PHandler` on the server and
render the client's snapshot; payment and start are not separate app actions.
Paid entries are committed: no voluntary entry cancellation is exposed.
Its timers represent queue, no-show and game deadlines. Failed webhooks use
redelivery, never recovery timers.

## Restrictions

`BANKROLL_RESTRICTIONS` holds a JSON policy that says where, and from what
age, this app takes real money: countries and regions that are open or
blocked, and minimum ages by country and region. Bankroll sets it on a
builder app. Unset means no restriction. A malformed policy raises an
error instead of allowing play. Format and rules:
https://docs.joinbankroll.com/build/restrictions

Call `paidPlayRestriction(session)` on the server after `getSession(request)`
verifies the token, before allowing paid actions, and refuse while `reason`
is set. The P2P route example in the engine README includes this check. Use
`useMe().me.restriction` to explain the refusal and disable paid actions in
the UI; wait for `me` before enabling them. Never decide from a location or
an age supplied in a request body or by the client. Webhooks must still
process existing payments, deadlines and refunds regardless of the player's
restriction.

## Practice, and the review card

A player who has never seen the game will not pay to learn its controls. A
paid game here gives the same game away first: the same rules and scoring,
as many tries as they want, said plainly on the screen to be free, and kept
out of results, matches, and payouts. It is one screen, and it is where a new
player's first minutes go.

Bankroll draws its own review card, thumbs up or down, over the app when
`bankroll.promptReview()` is called. The host decides how often it appears
and keeps the answer, so the call is safe to repeat and never rejects. The
moment worth spending it on is the end of a player's first round, not the
load of the page; call it without awaiting, and let Bankroll draw the card
rather than building one.

## Shared app UI

**Apply safe-area padding once.** Home and Results use the padded app shell.
`/app` exports `viewportFit: 'cover'`; `.app-shell` in `src/app/globals.css` uses
`env(safe-area-inset-*)` to keep content clear of the notch, status bar, and
home indicator. Padding is the larger of the device inset and the normal
spacing (2.5rem top, 0.75rem bottom, 1.25rem horizontally). Keep the header and
surface inside that shell without adding a second inset. For full-bleed
gameplay, let the scene fill the viewport and apply safe-area padding once to
its HUD and controls, rather than enclosing the whole scene in the padded
shell; see [anatomy.md](./anatomy.md). A phone-sized browser viewport alone does
not simulate a notch; check on a device or override the browser's safe-area
insets when checking layout.

**The surface owns its header.** `home.tsx` renders `BankrollBalances` at the
top right inside `Gate`. Keeping the header with the surface lets gameplay
hide it. Reuse `BankrollBalances` for its host reads and formatting.

**Home fits; only history scrolls.** The app shell fills the dynamic viewport
height. `TabbedScreen` reserves space for its header and footer and gives the
remaining height to the selected tab. The home tab must fit that height with
the tabs below it, without scrolling and without landing copy: the game and
its one action. Set `scroll: true` only on history (and settings, if any); the
footer stays visible. In development `TabbedScreen` logs a console error when
a non-scrolling tab overflows, which `npm run check` reports as a failure. The first tab is the default, `?tab=<id>` selects
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

A push to `main`, as described at the top. Bankroll builds, signs, and
deploys it; the app's Vercel project, wallet, and settings are Bankroll's.

## Do not edit

- `src/app/.well-known/**` — the manifest route derives origin, payment
  address, name, and icon at runtime, and serves the version Bankroll signed
  at the last build. Serving it is what makes this a Bankroll app.
- `src/lib/store.ts` and `src/lib/treasury.ts` — the storage and money
  adapters. The payee and the owner are settings, never values in code.
- `engine/p2p/**`, `scripts/**`, and `app-tokens.json` — the engine, the
  checks, and the token declaration. Bind the engine and declare tokens;
  do not rewrite them.
- `vercel.json` keeps `git.deploymentEnabled: false`, and nothing is created
  or edited under `.github/workflows`.

The app uses no external images, fonts, scripts, or APIs that need an account
or a key.

## The icon and the name

Put the app's icon at `public/.well-known/bankroll-icon.png`: a square PNG,
512×512, bold and simple with no small text, because Bankroll shows it at 60
pixels wide on the app's tile. Until that file exists, Bankroll shows a
monogram of the app's name.

The name is set once, by `bankroll apps create --name`; a push does not
change it. `bankroll-app.json` is read only by Bankroll's builder, in its own
sandbox, so writing it in a laptop clone does nothing.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
