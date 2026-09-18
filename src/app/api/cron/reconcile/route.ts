import { reconciliationRoute } from '@/lib/p2p/cron';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// Bind your game's p2p.runReconciliation here; recipes/p2p.md shows the wiring.
export const GET = (request: Request) => reconciliationRoute(request);
