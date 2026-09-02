// Loads the app in a headless, phone-sized Chromium with a stand-in Bankroll
// host, and fails on any console error, page error, or failed request.
// Screenshots go to checks/. For a coding agent, or a CI job, this is the
// closest thing to opening the app on a phone.
//
//   npm run check -- /app            # one path
//   npm run check -- /app?level=2 /  # several
//
// The dev server must be running with BANKROLL_MOCK=1 (see .env.example): that
// is what lets the server accept the stand-in host's token and signatures.
// The host itself comes from @joinbankroll/sdk/mock.
import fs from 'node:fs';
import path from 'node:path';

import { mockHostScript } from '@joinbankroll/sdk/mock';
import { chromium } from 'playwright';

const BASE_URL = process.env.CHECK_BASE_URL ?? 'http://localhost:3000';
const DEFAULT_PATHS = ['/app'];
const OUT_DIR = 'checks';
const VIEWPORT = { width: 390, height: 844 };
const SETTLE_MS = 1500;
const NAVIGATION_TIMEOUT_MS = 45_000;
const HTTP_ERROR = 400;

// Chrome logs its own noise as errors; none of these are the app's fault.
const IGNORED_CONSOLE = [/favicon\.ico/, /React DevTools/];

async function readManifest() {
  const response = await fetch(`${BASE_URL}/.well-known/bankroll.jwt`);
  if (!response.ok) throw new Error(`manifest: HTTP ${response.status} — is the dev server up?`);
  const [, payload] = (await response.text()).split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

function fileNameFor(urlPath) {
  const name = urlPath
    .replace(/^\//, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '');
  return `${name || 'root'}.png`;
}

async function main() {
  const paths = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_PATHS;
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const problems = [];
  const manifest = await readManifest();
  const payee = manifest.capabilities?.payments;
  if (!manifest.name) problems.push('manifest: no app name (BANKROLL_APP_NAME)');
  if (!payee) problems.push('manifest: no payee (BANKROLL_TREASURY_KEY or BANKROLL_PAYEE)');

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  await context.addInitScript(mockHostScript({ payee: payee ?? '' }));

  for (const urlPath of paths) {
    const page = await context.newPage();
    const found = [];
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (IGNORED_CONSOLE.some((pattern) => pattern.test(text))) return;
      found.push(`console: ${text}`);
    });
    page.on('pageerror', (error) => found.push(`page error: ${error.message}`));
    page.on('requestfailed', (request) => {
      found.push(`request failed: ${request.method()} ${request.url()}`);
    });
    page.on('response', (response) => {
      if (response.status() >= HTTP_ERROR)
        found.push(`HTTP ${response.status()}: ${response.url()}`);
    });

    try {
      await page.goto(`${BASE_URL}${urlPath}`, {
        waitUntil: 'networkidle',
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      await page.waitForTimeout(SETTLE_MS);
    } catch (error) {
      found.push(`could not load: ${error.message}`);
    }
    const file = path.join(OUT_DIR, fileNameFor(urlPath));
    await page.screenshot({ path: file, fullPage: false }).catch(() => {});
    console.log(`${found.length === 0 ? 'ok  ' : 'FAIL'} ${urlPath}  →  ${file}`);
    for (const problem of found) {
      console.log(`      ${problem}`);
      problems.push(`${urlPath}: ${problem}`);
    }
    await page.close();
  }

  await browser.close();
  if (problems.length > 0) {
    console.log(`\n${problems.length} problem(s). Fix them and run the check again.`);
    process.exit(1);
  }
  console.log('\nAll checks passed. Look at the screenshots in checks/.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
