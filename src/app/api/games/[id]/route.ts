import { gameView, readGame } from '@/lib/games';
import { gameRoute, type GameContext } from '@/lib/game-route';

export function GET(request: Request, context: GameContext) {
  return gameRoute(request, async (wallet) => ({
    game: gameView(await readGame(wallet, (await context.params).id)),
  }));
}
