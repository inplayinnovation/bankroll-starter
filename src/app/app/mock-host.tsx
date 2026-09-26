import { mockEnabled, mockHostScript } from '@joinbankroll/sdk/mock';

import { payeeAddress } from '@/lib/treasury';

// The stand-in host for a browser, in development under BANKROLL_MOCK=1: the
// same window.bankroll the phone injects, with a pretend user and made-up
// signatures the server accepts, so the app runs in any browser and not only
// on a phone. `npm run check` injects its own host before the page loads,
// sometimes as the owner, so this one yields to a host that is already there.
// A production build never renders it: mockEnabled() is false there.
export function MockHost() {
  if (!mockEnabled()) return null;
  const host = mockHostScript({ payee: payeeAddress() ?? '' });
  return <script dangerouslySetInnerHTML={{ __html: `if (!window.bankroll) { ${host} }` }} />;
}
