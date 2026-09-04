// Loads the app in a headless, phone-sized Chromium with a stand-in Bankroll
// host, and fails on any console error, page error, or failed request.
// Screenshots go to checks/. For a coding agent, or a CI job, this is the
// closest thing to opening the app on a phone.
//
//   npm run check -- /app            # one path
//   npm run check -- /app?level=2 /  # several
//   npm run check -- --owner /admin # as the app's owner (wallet = payee)
//   npm run check -- --admin-probe   # only the player probe of /api/admin
//
// The dev server must be running with BANKROLL_MOCK=1 (see .env.example): that
// is what lets the server accept the stand-in host's token and signatures.
// The host itself comes from @joinbankroll/sdk/mock.
import fs from 'node:fs';
import path from 'node:path';

import { BANKROLL_TOKEN_HEADER } from '@joinbankroll/sdk';
import { mockHostScript, mockToken } from '@joinbankroll/sdk/mock';
import { chromium } from 'playwright';

const BASE_URL = process.env.CHECK_BASE_URL ?? 'http://localhost:3000';
const DEFAULT_PATHS = ['/app'];
// --owner loads pages as the app's owner: the stand-in user's wallet is the
// payee, which is what an owner check in the app compares against.
const OWNER_FLAG = '--owner';
const OWNER_USERNAME = 'owner';
// The admin route, if the app has one, must refuse everyone but the owner
// before it reads anything. It is probed as an ordinary player after the
// pages, or alone with --admin-probe. The only good answers: 401 or 403, or
// 404 and 405 for an app with no such route or method. The builder refuses to
// publish an app that fails this.
const ADMIN_PROBE_FLAG = '--admin-probe';
const ADMIN_ROUTE = '/api/admin';
const ADMIN_METHODS = ['POST', 'GET'];
const ADMIN_OK_STATUSES = new Set([401, 403, 404, 405]);
const OUT_DIR = 'checks';
// The current base iPhone, in CSS points; the app must also work from 360 to
// 440 wide.
const VIEWPORT = { width: 393, height: 852 };
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

async function probeAdmin() {
  const problems = [];
  const headers = { [BANKROLL_TOKEN_HEADER]: mockToken(), 'content-type': 'application/json' };
  for (const method of ADMIN_METHODS) {
    let status;
    try {
      const response = await fetch(`${BASE_URL}${ADMIN_ROUTE}`, {
        method,
        headers,
        body: method === 'POST' ? '{}' : undefined,
      });
      status = response.status;
    } catch (error) {
      problems.push(`${method} ${ADMIN_ROUTE}: ${error.message}`);
      continue;
    }
    if (ADMIN_OK_STATUSES.has(status)) continue;
    problems.push(
      `${method} ${ADMIN_ROUTE} answered ${status} to an ordinary player; it must answer 401 or 403 before reading anything`,
    );
  }
  console.log(
    `${problems.length === 0 ? 'ok  ' : 'FAIL'} ${ADMIN_ROUTE} refuses an ordinary player`,
  );
  for (const problem of problems) console.log(`      ${problem}`);
  return problems;
}

function fileNameFor(urlPath, asOwner) {
  const name = urlPath
    .replace(/^\//, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '');
  return `${asOwner ? 'owner-' : ''}${name || 'root'}.png`;
}

async function main() {
  const args = process.argv.slice(2);
  const asOwner = args.includes(OWNER_FLAG);
  const probeOnly = args.includes(ADMIN_PROBE_FLAG);
  const requested = args.filter((arg) => arg !== OWNER_FLAG && arg !== ADMIN_PROBE_FLAG);
  const paths = requested.length ? requested : DEFAULT_PATHS;
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const problems = [];
  if (probeOnly) {
    problems.push(...(await probeAdmin()));
    if (problems.length > 0) process.exit(1);
    return;
  }
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
  const user = asOwner ? { wallet: payee ?? '', username: OWNER_USERNAME } : {};
  await context.addInitScript(mockHostScript({ payee: payee ?? '', ...user }));

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
    const file = path.join(OUT_DIR, fileNameFor(urlPath, asOwner));
    await page.screenshot({ path: file, fullPage: false }).catch(() => {});
    console.log(`${found.length === 0 ? 'ok  ' : 'FAIL'} ${urlPath}  →  ${file}`);
    for (const problem of found) {
      console.log(`      ${problem}`);
      problems.push(`${urlPath}: ${problem}`);
    }
    await page.close();
  }

  await browser.close();
  problems.push(...(await probeAdmin()));
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
