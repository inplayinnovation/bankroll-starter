import { MockHost } from '@joinbankroll/sdk/next';
import type { Viewport } from 'next';

import { payeeAddress } from '@/lib/treasury';

// Let the background reach the screen edges; .app-shell keeps the content
// inside the device's safe area. The public site has its own layout.
export const viewport: Viewport = {
  viewportFit: 'cover',
};

// MockHost is the stand-in host for a plain browser tab, under BANKROLL_MOCK=1
// outside production: the window.bankroll the phone would inject, with a
// pretend user and made-up signatures the server accepts. In the simulator it
// steps aside and the SDK's own bridge is the host. A production build
// renders nothing.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="app-shell mx-auto flex h-dvh w-full max-w-md min-w-0 flex-col overflow-hidden">
      <MockHost payee={payeeAddress() ?? ''} />
      {children}
    </main>
  );
}
