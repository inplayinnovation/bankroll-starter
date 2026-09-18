import { getOrigin } from '@joinbankroll/sdk/next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from '@/app/api/cron/reconcile/route';
import { reconciliationRoute } from '@/lib/p2p/cron';

const runReconciliation = vi.fn<NonNullable<Parameters<typeof reconciliationRoute>[1]>>();
const configuredGET = (request: Request) => reconciliationRoute(request, runReconciliation);

vi.mock('@joinbankroll/sdk/next', () => ({ getOrigin: vi.fn() }));

const secret = 'test-secret-not-a-player-session';
const request = (authorization?: string) =>
  new Request('https://app.test/api/cron/reconcile?wallet=forged&cursor=skip', {
    headers: authorization ? { authorization } : {},
  });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('CRON_SECRET', secret);
  vi.mocked(getOrigin).mockResolvedValue('https://app.test');
  vi.mocked(runReconciliation).mockResolvedValue({
    skipped: false,
    processed: 2,
    failed: 0,
    missing: 0,
    completedPass: true,
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('scheduled endpoint', () => {
  it('authenticates the unbound skeleton route before reporting that it needs a game', async () => {
    expect((await GET(request())).status).toBe(401);
    const response = await GET(request(`Bearer ${secret}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ skipped: true, reason: 'p2p_not_configured' });
    expect(runReconciliation).not.toHaveBeenCalled();
    expect(getOrigin).not.toHaveBeenCalled();
  });
  it('fails closed when unconfigured, including Bearer undefined', async () => {
    vi.stubEnv('CRON_SECRET', '');
    expect((await configuredGET(request('Bearer undefined'))).status).toBe(401);
    expect((await configuredGET(request('Bearer '))).status).toBe(401);
    expect(runReconciliation).not.toHaveBeenCalled();
    expect(getOrigin).not.toHaveBeenCalled();
  });
  it.each([undefined, 'Bearer player-session', `Bearer ${secret}x`, secret])(
    'rejects an invalid scheduler credential: %s',
    async (token) => {
      expect((await configuredGET(request(token))).status).toBe(401);
      expect(runReconciliation).not.toHaveBeenCalled();
    },
  );
  it('runs the global job and never accepts a wallet or cursor from the URL', async () => {
    const response = await configuredGET(request(`Bearer ${secret}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(runReconciliation).toHaveBeenCalledExactlyOnceWith('https://app.test');
  });
  it('reports partial failures while the next scheduled pass remains able to retry', async () => {
    vi.mocked(runReconciliation).mockResolvedValueOnce({
      skipped: false,
      processed: 2,
      failed: 1,
      missing: 0,
      completedPass: true,
    });
    const response = await configuredGET(request(`Bearer ${secret}`));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ processed: 2, failed: 1 });
  });
});
