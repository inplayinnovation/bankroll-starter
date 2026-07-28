import { readFileSync } from 'node:fs';

import { defineConfig } from 'vitest/config';

// The Blob conformance tests need a token for a throwaway store, kept in
// .env.test.local (gitignored). Read here rather than relying on ambient
// environment, so the suite's credentials are always something a developer
// opted into for this project.
function testEnvFile(): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(new URL('./.env.test.local', import.meta.url), 'utf8')
        .split('\n')
        .filter((line) => line.trim() && !line.trimStart().startsWith('#'))
        .map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
        }),
    );
  } catch {
    // Absent is normal — the Blob tests skip themselves.
    return {};
  }
}

export default defineConfig({
  resolve: {
    // Matches the `@/*` path in tsconfig.json.
    alias: { '@': new URL('./src/', import.meta.url).pathname },
  },
  test: {
    env: {
      // The store reads this to choose a backend. Defaults to the filesystem —
      // NODE_ENV=test keeps its data in bankroll/test/, away from the store
      // you're developing against — but `STORE=blob npm test` runs the same
      // suite against Vercel Blob, which is what a deployment actually uses.
      STORE: process.env.STORE ?? 'fs',
      ...testEnvFile(),
      // The Blob backend reads BLOB_READ_WRITE_TOKEN — which is exactly the
      // variable `vercel env pull` fills with a REAL store's token. Pinning it
      // to the throwaway token, and to empty when there isn't one, is what stops
      // `STORE=blob npm test` from writing to production data that happens to be
      // configured on this machine. Last, so nothing can override it.
      //
      // This assignment used to live in the store conformance test. That test
      // moved to the SDK with the code it covers, and the safety wiring has to
      // stay here, where the suite that writes still runs.
      BLOB_READ_WRITE_TOKEN: testEnvFile().DANGEROUS_BLOB_TOKEN ?? '',
    },
    // Test files share one filesystem store, so they run one at a time rather
    // than racing each other's fixtures.
    fileParallelism: false,
  },
});
