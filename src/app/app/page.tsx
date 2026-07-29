// The app itself — what Bankroll loads when a user opens it. `/` is the
// landing page that sends them here, the same split a real app has.
//
// This page stays a shell: it works out whether the app is configured, builds
// the developer rows, and renders one component. Swap that component for yours;
// what it demonstrates (charge → confirm → record, and pay out) is the part
// worth keeping.
import { DevTools, type DevRow } from '@joinbankroll/sdk/react';
import { rpcUrl, treasuryAddress, usingPublicRpc } from '@joinbankroll/sdk/server';

import { appName, appNameConfigured } from '@/lib/app-identity';
import { storeDirectory, usingFilesystemStore } from '@/lib/store';

import { Demo } from '../demo';

export const dynamic = 'force-dynamic';

export default function App() {
  const treasury = treasuryAddress();
  const onFilesystem = usingFilesystemStore();
  const storage = onFilesystem || Boolean(process.env.BLOB_READ_WRITE_TOKEN);
  const ready = Boolean(treasury) && storage;

  const rows: DevRow[] = [
    {
      label: 'Treasury',
      value: treasury ?? 'not set',
      ok: Boolean(treasury),
      copy: Boolean(treasury),
    },
    {
      label: 'Storage',
      value: onFilesystem ? storeDirectory() : storage ? 'Vercel Blob' : 'no Blob store',
      ok: storage,
    },
    { label: 'Name', value: appName(), ok: appNameConfigured() },
    // The endpoint itself, not a verdict on it — "configured" tells a developer
    // nothing they can act on when a call is failing. The host identifies it in
    // the width available; the copy button gives back the whole URL.
    {
      label: 'RPC',
      value: rpcUrl(),
      display: new URL(rpcUrl()).host,
      ok: !usingPublicRpc(),
      copy: true,
    },
  ];

  // Developer tools overlay the app only inside Bankroll, where it actually
  // runs, and only in development.
  const devTools = process.env.NODE_ENV === 'development' ? <DevTools rows={rows} /> : null;

  return <Demo ready={ready} devTools={devTools} />;
}
