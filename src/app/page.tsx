// The landing page — the equivalent of any app's public site. Its whole job is
// to hand someone the link that opens the app on their phone, which is what a
// real Bankroll app's homepage does too.
//
// Bankroll's own /play generates the QR, detects the device, and handles
// installing the app for someone who doesn't have it. Linking there beats
// reimplementing any of it.
import { playLink } from '@joinbankroll/sdk';
import { getOrigin } from '@joinbankroll/sdk/next';

import { APP_PATH, appName } from '@/lib/app-identity';

export const dynamic = 'force-dynamic';

export default async function Home() {
  // playLink refuses anything that isn't https, which is exactly what Bankroll
  // cannot open — so on a localhost dev server there is nothing to render here.
  // That is fine: `npm run bankroll` prints a QR for the tunnel, which is how
  // you get it onto a phone.
  const origin = await getOrigin();
  const href = origin.startsWith('https://') ? playLink(`${origin}${APP_PATH}`) : null;

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 text-center">
      <div className="flex flex-col gap-3">
        <h1 className="text-4xl font-semibold tracking-tight">{appName()}</h1>
        <p className="max-w-xs text-neutral-400">
          Buy a loot box, open it, get paid. Runs inside the Bankroll app.
        </p>
      </div>

      {href ? (
        <a className="btn" href={href}>
          Open on Bankroll
        </a>
      ) : (
        <p className="max-w-xs text-sm text-neutral-500">
          Run <code className="text-neutral-300">npm run dev</code> to get a link that opens this
          on a phone.
        </p>
      )}
    </main>
  );
}
