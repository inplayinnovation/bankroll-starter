import { createGame, gameView, listGames } from '@/lib/games';
import { gameRoute } from '@/lib/game-route';

export function POST(request: Request) {
  return gameRoute(request, async (wallet) => ({ game: gameView(await createGame(wallet)) }));
}

export function GET(request: Request) {
  return gameRoute(request, (wallet) =>
    listGames(wallet, new URL(request.url).searchParams.get('cursor') ?? undefined),
  );
}
