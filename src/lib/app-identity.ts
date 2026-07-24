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
