// The Bankroll app manifest. Serving this from your origin is what makes this
// app a Bankroll app — there is nothing to register and no key to sign it with.
// The host fetches it here and binds it to this origin by checking `sub`.
//
// The manifest FORMAT ships in @joinbankroll/sdk/next, so a change to it
// reaches this app through `npm update`. What's below is only what is yours:
// the name, where the app boots, the address that takes payment, and your token.
//
// Your app ICON is not in the manifest: serve a square PNG at the fixed path
// /.well-known/bankroll-icon.png (drop it in public/.well-known/). Until you
// do, Bankroll shows a monogram of your app's name.
import { manifestRoute } from '@joinbankroll/sdk/next';
import { treasuryAddress } from '@joinbankroll/sdk/server';

import { APP_PATH, appName, appTokenMint, appTokenName } from '@/lib/app-identity';

// Required: the manifest is built from the request's own host, so it must not
// be prerendered. The SDK cannot declare this for you — Next only reads it from
// the route file itself.
export const dynamic = 'force-dynamic';

export const GET = manifestRoute({
  launch: APP_PATH,
  name: appName,
  payments: treasuryAddress,
  tokenMint: appTokenMint,
  tokenName: appTokenName,
});
