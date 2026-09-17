import { gameView, startGame } from '@/lib/games';
import { gameRoute, type GameContext } from '@/lib/game-route';

export function POST(request: Request, context: GameContext) {
  return gameRoute(request, async (wallet) => ({
    game: gameView(await startGame(wallet, (await context.params).id)),
  }));
}
