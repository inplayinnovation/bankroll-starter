// The Bankroll app manifest. Serving this file from your origin is what makes
// this app a Bankroll app — there is nothing to register and no key to sign it
// with. The host fetches it here and binds it to this origin by checking `sub`.
//
// Nothing in it is hardcoded: the origin comes from the request, the payment
// address from your treasury key, the name from your environment. You should
// never need to edit this file.
//
// Your app ICON is not in the manifest: serve a square PNG at the fixed path
// /.well-known/bankroll-icon.png (drop it in public/.well-known/). Until you
// do, Bankroll shows a monogram of your app's name.
import { appName } from '@/lib/app-identity';
import { getOrigin } from '@/lib/origin';
import { treasuryAddress } from '@/lib/treasury';

export const dynamic = 'force-dynamic';

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

export async function GET() {
  const origin = await getOrigin();
  const payments = treasuryAddress();

  // An unsecured JWT (alg: none, empty signature) — the origin it is served
  // from is the proof, not a signature.
  const header = { alg: 'none', typ: 'bankroll-app-manifest+jwt' };
  const payload = {
    aud: 'bankroll-app-host',
    // Payments are declared only once a treasury exists, so an app that hasn't
    // finished setup advertises what it can actually honor.
    capabilities: payments ? { session: true, payments } : { session: true },
    manifestVersion: 1,
    name: appName(),
    sub: origin,
  };

  return new Response(`${base64url(header)}.${base64url(payload)}.`, {
    headers: { 'content-type': 'application/jwt' },
  });
}
