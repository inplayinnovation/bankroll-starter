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

// Your own token, if you issue one: a mint you created and hand out for free —
// promo credit, or funds for testing. Set BANKROLL_APP_TOKEN_MINT and the
// manifest declares it, which is what lets a charge settle in it and what makes
// Bankroll show it as this app's funds rather than an unattributed holding.
//
// Mint it with 9 decimals and treat one token as one dollar; that is the only
// shape charges settle in. It is worth nothing outside your app, which is the
// point — you can give away as much as you like, and it can never be cashed out.
export const appTokenMint = (): string | null => process.env.BANKROLL_APP_TOKEN_MINT || null;

export const appTokenName = (): string =>
  process.env.BANKROLL_APP_TOKEN_NAME || `${appName()} Tokens`;
