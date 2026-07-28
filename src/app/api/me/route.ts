import { getSession } from '@joinbankroll/sdk/next';
import { treasuryAddress } from '@joinbankroll/sdk/server';

import { appTokens } from '@/lib/app-identity';

export async function GET(request: Request) {
  const session = await getSession(request);
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });

  return Response.json({
    username: session.user.username,
    wallet: session.user.wallet,
    // `identity` is truthy only for a verified real person — the client uses
    // this to decide whether to prompt verification before a paid action.
    identified: Boolean(session.user.identity),
    // Present only when the user's date of birth is on file — an age gate
    // stricter than "is a verified adult" needs this rather than `identified`.
    age: session.user.identity ? (session.user.identity.age ?? null) : null,
    // Where the user is for THIS session, not where they live. Null when the
    // host didn't report one.
    geo: session.geo ?? null,
    treasuryConfigured: treasuryAddress() !== null,
    // The app's own tokens, so the client can offer paying with them. Naming
    // the mints here is safe: the manifest already declares them publicly, and
    // that declaration is what bounds what this app may charge.
    appTokens: Object.entries(appTokens()).map(([mint, token]) => ({
      mint,
      name: token.name ?? 'App Tokens',
    })),
  });
}
