import { gameView, submitWord } from '@/lib/games';
import { gameRoute, type GameContext } from '@/lib/game-route';

export function POST(request: Request, context: GameContext) {
  return gameRoute(request, async (wallet) => {
    const body = await request.json().catch(() => null);
    return {
      game: gameView(
        await submitWord(wallet, (await context.params).id, body?.sequence, body?.path),
      ),
    };
  });
}
