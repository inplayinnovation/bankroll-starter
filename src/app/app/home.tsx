'use client';

// The app's surface — the one file a branch replaces. The gates (gate.tsx) and
// the shell (page.tsx) stay; build here.
//
// It is NOT a wallet: the Bankroll host holds the user's money, identity, and
// location. This app only reads what the host signed — /api/me reads it
// server-side from the session token, so the client cannot lie about any of it.
import { useMe } from '@/lib/client/bankroll';

import { Loading } from './gate';

export function Home() {
  const { me } = useMe();
  if (!me) return <Loading />;

  return (
    <div className="flex flex-col gap-4">
      <header className="text-sm text-neutral-400">@{me.username}</header>
      <h1 className="text-2xl font-semibold">Your app goes here</h1>
      <p className="text-neutral-300">
        The session is verified, the gates have passed, and the money path in{' '}
        <code>src/lib</code> is ready to wire up. Replace this screen.
      </p>
    </div>
  );
}
