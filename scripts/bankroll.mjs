// `npm run bankroll` is the dev server plus a way onto a phone. The app only
// ever runs inside Bankroll, and Bankroll refuses any origin that isn't public
// HTTPS — so localhost can't be opened however reachable it is. A Cloudflare
// quick tunnel comes up alongside the dev server, and the QR printed below
// opens the app through it.
//
// `npm run dev` stays plain `next dev`; nothing here changes it.
//
// Quick tunnels need no Cloudflare account, and because the phone reaches the
// app over the public internet rather than the local network, this also works
// on networks that isolate clients from each other (most hotel, venue, and
// in-flight Wi-Fi).
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import bs58 from 'bs58';
import { bin, install, Tunnel } from 'cloudflared';
import qrcodeModule from 'qrcode-generator';

// qrcode-generator is CJS; the default import can arrive as the namespace.
const qrcode = typeof qrcodeModule === 'function' ? qrcodeModule : qrcodeModule.default;

const DEFAULT_PORT = '3000';
const TUNNEL_TIMEOUT_MS = 20_000;
const TUNNEL_ORIGIN_ENV = 'BANKROLL_DEV_TUNNEL_ORIGIN';
// cloudflared logs its own control-plane host while requesting the tunnel, and
// the library matches any *.trycloudflare.com hostname — so this one arrives
// first and has to be skipped to reach the assigned subdomain.
const TUNNEL_API_ORIGIN = 'https://api.trycloudflare.com';
// The app lives at /app; / is its landing page. The QR points at Bankroll's
// own /play, which handles installing the app and deep-linking into it — work
// this script has no business reimplementing.
const APP_PATH = '/app';
const PLAY_LINK = 'https://joinbankroll.com/play?url=';

// Error correction M, smallest version that fits.
const QR_TYPE_AUTO = 0;
const QR_ERROR_CORRECTION = 'M';
const QR_QUIET_ZONE = 2;

// Two vertical modules per character cell, coloured explicitly rather than
// relying on the terminal's palette — scanners want dark-on-light, and a dark
// terminal would otherwise render the code inverted.
const BLACK = 16;
const WHITE = 231;
const HALF_BLOCK = '\u2580';
const RESET = '\u001b[0m';

function qrLines(text) {
  const qr = qrcode(QR_TYPE_AUTO, QR_ERROR_CORRECTION);
  qr.addData(text);
  qr.make();

  const size = qr.getModuleCount();
  const min = -QR_QUIET_ZONE;
  const max = size + QR_QUIET_ZONE;
  const isDark = (row, col) =>
    row >= 0 && row < size && col >= 0 && col < size && qr.isDark(row, col);

  const lines = [];
  for (let row = min; row < max; row += 2) {
    let line = '';
    for (let col = min; col < max; col++) {
      const upper = isDark(row, col) ? BLACK : WHITE;
      const lower = isDark(row + 1, col) ? BLACK : WHITE;
      line += `\u001b[38;5;${upper}m\u001b[48;5;${lower}m${HALF_BLOCK}`;
    }
    lines.push(line + RESET);
  }
  return lines;
}

// Solana's public endpoint. Fine to develop against, rate-limited, and the one
// thing here worth upgrading later — so it's offered with a default rather than
// left for someone to discover.
const PUBLIC_MAINNET_RPC = 'https://api.mainnet-beta.solana.com';

// A Solana secret key is just the 32-byte ed25519 seed followed by the 32-byte
// public key, base58-encoded — so node's own crypto covers it, and the app
// avoids a dependency on @solana/web3.js that printed a deprecation warning
// into the middle of these prompts.
//
// RFC 8410 fixes ed25519's DER encodings at 48 bytes (PKCS#8) and 44 (SPKI),
// each ending in the raw 32-byte key, so the tail is all that's needed.
function generateTreasury() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const address = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  return {
    secretKey: bs58.encode(Buffer.concat([seed, address])),
    address: bs58.encode(address),
  };
}

// Defaults are used verbatim when nothing is attached to the terminal, so this
// never hangs a CI run or a non-interactive shell waiting on input.
async function ask(question, fallback) {
  if (!process.stdin.isTTY) return fallback;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`  ${question} [${fallback}] `);
    return answer.trim() || fallback;
  } finally {
    rl.close();
  }
}

const port = process.env.PORT ?? DEFAULT_PORT;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nextBin = join(root, 'node_modules', '.bin', 'next');
const envFile = join(root, '.env.local');

// First run: give the app everything it needs to actually work, so it starts up
// able to take money rather than telling you to go configure it. Both values
// are local — a Solana keypair and a name — so nothing here needs an account
// anywhere. Written before the dev server starts, since Next reads .env.local
// once at boot.
if (!existsSync(envFile)) {
  console.log('\n  Setting up this app. Press enter to accept a default.\n');
  const appName = await ask('App name', basename(root));
  const rpcUrl = await ask('Solana RPC', PUBLIC_MAINNET_RPC);

  const treasury = generateTreasury();
  writeFileSync(
    envFile,
    [
      '# Written by `npm run bankroll` on first run.',
      '# Gitignored, so none of this reaches a deployment.',
      '',
      '# Store state in local files instead of Vercel Blob, so this app runs',
      '# without a Vercel account. A deployment has no STORE and uses Blob.',
      'STORE=fs',
      '',
      '# The treasury: it receives payments and signs payouts. Real money — the',
      '# app moves mainnet HSUSD — so fund it with only what you need to test.',
      '# This key is in plaintext on your machine; when you deploy, generate a',
      '# separate one and set it as a sensitive variable on Vercel.',
      `BANKROLL_TREASURY_KEY=${treasury.secretKey}`,
      '',
      '# Shown when a user connects the app.',
      `BANKROLL_APP_NAME=${appName}`,
      '',
      '# The public endpoint is rate-limited; any provider works.',
      `SOLANA_RPC_URL=${rpcUrl}`,
      '',
    ].join('\n'),
  );

  console.log(`
  Created .env.local

    app name   ${appName}
    treasury   ${treasury.address}
    storage    local files (bankroll/development/)
    rpc        ${rpcUrl === PUBLIC_MAINNET_RPC ? 'public mainnet (rate-limited)' : rpcUrl}
`);
}

if (!existsSync(bin)) await install(bin);

const tunnel = Tunnel.quick(`http://localhost:${port}`);

// The tunnel is a convenience, not a prerequisite — without one the dev server
// still serves localhost fine. So a failure degrades to a page without a QR
// code rather than blocking development entirely.
const origin = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), TUNNEL_TIMEOUT_MS);
  const settle = (value) => {
    clearTimeout(timer);
    tunnel.off('url', onUrl);
    resolve(value);
  };
  // Keep listening past the control-plane host rather than taking the first
  // URL, which is a race the wrong answer sometimes wins.
  const onUrl = (url) => {
    if (url !== TUNNEL_API_ORIGIN) settle(url);
  };
  tunnel.on('url', onUrl);
  tunnel.once('error', () => settle(null));
});

if (origin) {
  // Scanning this beats opening a page to scan a page: the terminal already
  // has the developer's attention, and Bankroll's /play handles installing the
  // app and deep-linking into it.
  const link = `${PLAY_LINK}${encodeURIComponent(origin + APP_PATH)}`;
  console.log('');
  for (const line of qrLines(link)) console.log('  ' + line);
  console.log(`\n  Scan to open the app on your phone\n  ${origin}${APP_PATH}\n`);
} else {
  console.warn('\n  No tunnel — opening the app on a phone needs one. Check your connection.\n');
}

const next = spawn(nextBin, ['dev', '-p', port], {
  stdio: 'inherit',
  env: origin ? { ...process.env, [TUNNEL_ORIGIN_ENV]: origin } : process.env,
});

const shutdown = () => {
  tunnel.stop();
  next.kill();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
next.on('exit', (code) => {
  tunnel.stop();
  process.exit(code ?? 0);
});
