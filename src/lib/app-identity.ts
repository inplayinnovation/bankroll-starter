// How your app introduces itself: the name Bankroll shows when someone
// connects it. Deployment config rather than source, so a fork never edits the
// manifest route — and preview and production can differ. (Your icon is a
// file, not config: public/.well-known/bankroll-icon.png.)
const DEFAULT_NAME = 'Bankroll Starter';

export const appName = (): string => process.env.BANKROLL_APP_NAME || DEFAULT_NAME;

export const appNameConfigured = (): boolean => Boolean(process.env.BANKROLL_APP_NAME);

// Where the app itself runs — the manifest's `launch` claim, and the target of
// the landing page's "Open on Bankroll" link. The host boots a connected app at
// this path; without the claim it would boot at the origin, which serves the
// landing page, not the app.
export const APP_PATH = '/app';

// The tokens you issue: mints you created and hand out for free — promo credit,
// or funds for testing. Declaring one in the manifest is what lets a charge
// settle in it, and what makes Bankroll show it as this app's funds rather than
// an unattributed holding.
//
// They live in app-tokens.json at the project root, which IS the manifest's
// `appTokens` claim — so this file is config, not a translation layer.
// `bankroll token create` mints one and adds it here.
//
// Worth nothing outside your app, which is the point: you can give away as much
// as you like, and it can never be cashed out.
import tokens from '../../app-tokens.json';

export const appTokens = (): Record<string, { name?: string; description?: string }> => tokens;

/** Every mint this app accepts alongside HSUSD — the money path's allowlist. */
export const appTokenMints = (): string[] => Object.keys(tokens);
