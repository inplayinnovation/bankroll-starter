// Everything your app says about itself lives in bankroll-app.json at the
// project root: its name, where users get help, and the tokens it issues. That
// file IS what Bankroll signs into the manifest — it reads the file in the
// commit it builds — so this module is config, not a translation layer. A fork
// inherits it and then changes it. (Your icon is a file too:
// public/.well-known/bankroll-icon.png.)
//
// What Bankroll assigns rather than what you claim — the payee, the app key,
// the signed manifest itself — stays in the deployment's settings.
import declaration from '../../bankroll-app.json';

interface Declaration {
  name?: string;
  supportUrl?: string;
  appTokens?: Record<string, { name?: string; description?: string }>;
}

const declared: Declaration = declaration;

// The name below stands in until you declare one, on this app's own pages and
// in the manifest it serves before Bankroll has signed one.
const DEFAULT_NAME = 'Bankroll Starter';

export const appName = (): string => declared.name?.trim() || DEFAULT_NAME;

// Where charges settle and what pays out is the treasury's business:
// src/lib/treasury.ts.

// Where your users get help. Bankroll offers it in this app's own menu, and
// opening it hands the URL to the operating system — so a help page, a
// `mailto:`, a `tel:`, or a chat invite all work. It may point anywhere; a
// support desk usually lives on somebody else's domain. Unset means no menu
// item, which is the right answer until you have somewhere to send people.
//
// Changing it later re-asks every existing user for consent, because a grant is
// bound to the exact manifest it was made against. Point it at something
// durable — a page you control that redirects — rather than a link you expect
// to rotate.
export const supportUrl = (): string | null => declared.supportUrl?.trim() || null;

// Where the app itself runs — the manifest's `launch` claim, and the target of
// the landing page's "Open on Bankroll" link. The host boots a connected app at
// this path; without the claim it would boot at the origin, which serves the
// landing page, not the app.
export const APP_PATH = '/app';

// The tokens you issue: mints you created and hand out for free — promo credit,
// or funds for testing. Declaring one is what lets a charge settle in it, and
// what makes Bankroll show it as this app's funds rather than an unattributed
// holding. Mint one, then add it to `appTokens` in bankroll-app.json (docs:
// build/app-tokens).
//
// Worth nothing outside your app, which is the point: you can give away as much
// as you like, and it can never be cashed out.
export const appTokens = (): Record<string, { name?: string; description?: string }> => declared.appTokens ?? {};

/** Every mint this app accepts alongside HSUSD — the money path's allowlist. */
export const appTokenMints = (): string[] => Object.keys(appTokens());
