import { requireSession, Unauthorized } from '@joinbankroll/sdk/next';
import { TooContended } from '@joinbankroll/sdk/store';

import { GameError } from '@/lib/games';

export type GameContext = { params: Promise<{ id: string }> };

// Wallet scope is established once at the HTTP boundary. No route accepts a
// wallet, seed, deadline, word, or score supplied by the page as authoritative.
export async function gameRoute(
  request: Request,
  run: (wallet: string) => Promise<object>,
): Promise<Response> {
  try {
    const session = await requireSession(request);
    const result = await run(session.user.wallet);
    return Response.json(
      { ...result, serverNow: Date.now() },
      {
        headers: { 'cache-control': 'private, no-store' },
      },
    );
  } catch (error) {
    if (error instanceof Unauthorized)
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    if (error instanceof GameError)
      return Response.json({ error: error.code }, { status: error.status });
    if (error instanceof TooContended)
      return Response.json({ error: 'try_again' }, { status: 409 });
    throw error;
  }
}
