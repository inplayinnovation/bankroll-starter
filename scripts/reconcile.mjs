import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import nextEnv from '@next/env';

process.env.NODE_ENV ??= 'development';
nextEnv.loadEnvConfig(process.cwd(), process.env.NODE_ENV === 'development');
if (!process.env.CRON_SECRET) throw new Error('Set CRON_SECRET in .env.local first.');
const target =
  process.argv.find((arg) => /^https?:\/\//.test(arg)) ??
  JSON.parse(await readFile('.next/dev/lock', 'utf8')).appUrl;
const watch = process.argv.includes('--watch');

// Use the existing server so its signer, origin handling, and SDK mock queue
// are identical to the app's. This command never starts another dev server.
do {
  try {
    const response = await fetch(new URL('/api/cron/reconcile', target), {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      redirect: 'error',
      signal: AbortSignal.timeout(65_000),
    });
    console.log(response.status, await response.json());
    if (!response.ok && !watch) process.exitCode = 1;
  } catch (error) {
    console.error(
      'Reconciliation request failed:',
      error instanceof Error ? error.message : 'unknown',
    );
    if (!watch) process.exitCode = 1;
  }
  if (watch) await delay(60_000);
} while (watch);
