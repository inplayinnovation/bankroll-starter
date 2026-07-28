import { describe, expect, it } from 'vitest';

import { storeDirectory } from '@joinbankroll/sdk/store/fs';

// Not tests of the app — tests of the assumptions the rest of the suite rests
// on. Each backend is kept away from real data by a different mechanism, and
// either failing would be silent: on the filesystem a fixture would delete the
// store you develop against, and on Blob a pulled production token would point
// the suite at live user data. Both get asserted loudly, and first.
describe('test environment', () => {
  it('runs with NODE_ENV=test', () => {
    expect(process.env.NODE_ENV).toBe('test');
  });

  it('runs against a known backend', () => {
    expect(['fs', 'blob']).toContain(process.env.STORE);
  });

  it.runIf(process.env.STORE === 'fs')('keeps filesystem data out of the dev store', () => {
    expect(storeDirectory()).toBe('bankroll/test');
    expect(storeDirectory()).not.toContain('development');
  });

  it.runIf(process.env.STORE === 'blob')('only ever reaches a throwaway Blob store', () => {
    // The token must have come from DANGEROUS_BLOB_TOKEN. A deployment's token
    // lives in BLOB_READ_WRITE_TOKEN, which is what `vercel env pull` writes —
    // so a suite running on whatever happens to be in the environment could be
    // reading and writing production data.
    expect(process.env.DANGEROUS_BLOB_TOKEN).toBeTruthy();
    expect(process.env.BLOB_READ_WRITE_TOKEN).toBe(process.env.DANGEROUS_BLOB_TOKEN);
  });
});
