// The app itself — what Bankroll loads when a user opens it. `/` is the
// landing page that sends them here, the same split a real app has.
//
// This page stays a shell: it works out whether the app is configured, builds
// the developer rows, and renders the surface inside the entry gates. The
// surface lives in home.tsx; this file and gate.tsx are the part branches
// leave alone.
import { DevTools, type DevRow } from '@joinbankroll/sdk/react';
import { rpcUrl, usingPublicRpc } from '@joinbankroll/sdk/server';

import { appName, appNameConfigured, payeeAddress, payoutsAvailable } from '@/lib/app-identity';
import { storeDirectory, usingFilesystemStore } from '@/lib/store';

import { Gate } from './gate';
import { Home } from './home';

export const dynamic = 'force-dynamic';

export default function App() {
  const payee = payeeAddress();
  const onFilesystem = usingFilesystemStore();
  const storage = onFilesystem || Boolean(process.env.BLOB_READ_WRITE_TOKEN);
  const ready = Boolean(payee) && storage;

  const rows: DevRow[] = [
    {
      label: 'Payee',
      value: payee ?? 'not set',
      ok: Boolean(payee),
      copy: Boolean(payee),
    },
    // Charge-only mode is a valid setup, so "off" is informational, not a fault.
    {
      label: 'Payouts',
      value: payoutsAvailable() ? 'treasury key set' : 'off (charge-only)',
      ok: true,
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

  return (
    <Gate ready={ready} devTools={devTools}>
      <Home />
    </Gate>
  );
}
