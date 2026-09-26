// The app itself — what Bankroll loads when a user opens it. `/` is the
// landing page that sends them here, the same split a real app has.
//
// This page stays a shell: it works out whether the app is configured and
// renders the surface inside the entry gates.
// The surface lives in home.tsx; this file and gate.tsx are the part branches
// leave alone.
import { payeeAddress } from '@/lib/treasury';
import { usingFilesystemStore } from '@/lib/store';

import { Gate } from './gate';
import { Home } from './home';

export const dynamic = 'force-dynamic';

export default function App() {
  const storage = usingFilesystemStore() || Boolean(process.env.BLOB_READ_WRITE_TOKEN);
  const ready = Boolean(payeeAddress()) && storage;

  return (
    <Gate ready={ready}>
      <Home />
    </Gate>
  );
}
