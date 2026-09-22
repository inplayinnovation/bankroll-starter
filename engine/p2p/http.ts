import type { EngineReply } from './protocol';
import { EngineError, type Actor } from './types';

interface HandlerOptions<View, Result> {
  engine: { handle(actor: Actor, input: unknown): Promise<EngineReply<View, Result>> };
  authenticate(request: Request): Actor | null | Promise<Actor | null>;
}

const clientErrors: Readonly<Record<string, number>> = {
  unauthenticated: 403,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  invalid_json: 400,
  invalid_argument: 400,
  invalid_round_id: 400,
  invalid_action: 400,
  invalid_limit: 400,
  invalid_cursor: 400,
  unknown_offer: 400,
  command_conflict: 409,
  stale_sequence: 409,
  needs_attention: 409,
  payment_required: 409,
  round_closed: 409,
  start_window_closed: 409,
  not_started: 409,
};

/** Standard authenticated POST transport; independent of any server framework. */
export function createP2PHandler<View, Result>(options: HandlerOptions<View, Result>) {
  const json = (value: unknown, status = 200, headers?: Record<string, string>) =>
    Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
  return async function POST(request: Request): Promise<Response> {
    if (request.method !== 'POST')
      return json(
        { error: { code: 'method_not_allowed', message: 'Use POST for engine requests.' } },
        405,
        { Allow: 'POST' },
      );
    try {
      const actor = await options.authenticate(request);
      if (!actor) throw new EngineError('unauthenticated');
      let input: unknown;
      try {
        input = await request.json();
      } catch {
        throw new EngineError('invalid_json');
      }
      return json(await options.engine.handle(actor, input));
    } catch (error) {
      const status = error instanceof EngineError ? clientErrors[error.code] : undefined;
      if (status && error instanceof EngineError)
        return json({ error: { code: error.code, message: error.message } }, status);
      return json(
        { error: { code: 'service_unavailable', message: 'The game is temporarily unavailable.' } },
        503,
      );
    }
  };
}
