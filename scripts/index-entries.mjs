import { readdir } from 'node:fs/promises';
import nextEnv from '@next/env';
import { fsBackend, storeDirectory } from '@joinbankroll/sdk/store/fs';
import { vercelBlobBackend } from '@joinbankroll/sdk/store/vercel';

process.env.NODE_ENV ??= 'development';
nextEnv.loadEnvConfig(process.cwd(), process.env.NODE_ENV === 'development');
const filesystem = process.env.STORE === 'fs';
const backend = filesystem ? fsBackend() : vercelBlobBackend();
// Same flat key as src/lib/p2p/entry-index.ts. This repair command only creates
// missing pointers; it never alters a game, discovers a payment, or sends money.
const indexPrefix = 'reconciliation/entries/';
let indexed = 0;
let existing = 0;

async function scan(prefix) {
  let cursor;
  do {
    const page = await backend.list(prefix, { limit: 100, cursor });
    for (const game of page.items) {
      if (game.schema !== 1 || !game.entry) continue;
      if (
        typeof game.wallet !== 'string' ||
        !/^\d{16}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(game.id)
      )
        throw new Error('Invalid paid game; no index written.');
      const path = `${indexPrefix}${game.id}.json`;
      if (await backend.createIfAbsent(path, { wallet: game.wallet, id: game.id })) indexed++;
      else {
        const record = await backend.readJson(path);
        if (record?.value.wallet !== game.wallet || record.value.id !== game.id)
          throw new Error('Conflicting entry index; no existing record changed.');
        existing++;
      }
    }
    cursor = page.cursor;
  } while (cursor);
}

if (filesystem) {
  // The SDK filesystem list is one directory deep. Blob's is recursive.
  const wallets = await readdir(`${storeDirectory()}/games`, { withFileTypes: true }).catch(
    (error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  for (const wallet of wallets) if (wallet.isDirectory()) await scan(`games/${wallet.name}/`);
} else await scan('games/');
console.log({ indexed, existing });
