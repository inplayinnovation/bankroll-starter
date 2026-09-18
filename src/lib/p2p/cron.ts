import { timingSafeEqual } from 'node:crypto';

import { getOrigin } from '@joinbankroll/sdk/next';

type Run = (
  origin: string,
) => Promise<
  | { skipped: true }
  | { skipped: false; processed: number; failed: number; missing: number; completedPass: boolean }
>;

export async function reconciliationRoute(request: Request, runReconciliation?: Run) {
  const secret = process.env.CRON_SECRET;
  const provided = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret ?? ''}`);
  if (!secret || provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  // The skeleton has no game hooks. Authenticate first, then report a missing
  // binding without touching the store or advancing the worker's cursor.
  // The skeleton schedules this route before any game binds a worker. An
  // unbound run is a no-op, not a failure, so the schedule never logs errors
  // for an app that has no p2p game.
  if (!runReconciliation) {
    return Response.json(
      { skipped: true, reason: 'p2p_not_configured' },
      { headers: { 'cache-control': 'private, no-store' } },
    );
  }
  const result = await runReconciliation(await getOrigin());
  return Response.json(result, {
    status: !result.skipped && result.failed ? 503 : 200,
    headers: { 'cache-control': 'private, no-store' },
  });
}
