'use client';

import { useSyncExternalStore } from 'react';

import type { P2PClient } from './client';

/** Subscribe to a client owned by the app's surface or provider. */
export function useP2PGame<View, Result>(client: P2PClient<View, Result>) {
  // Unsubscribing only disconnects this observer. Disposing here would kill a
  // shared client, including React's development setup/cleanup/setup cycle.
  return useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
}
