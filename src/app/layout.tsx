import type { Metadata, Viewport } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'Bankroll Starter',
  description: 'A real-money app built on Bankroll',
};

// The app is opened inside Bankroll on a phone, so it has to draw into the area
// the OS reserves for the notch and the home indicator rather than stopping
// short of it. `cover` is also what gives env(safe-area-inset-*) a real value —
// see .safe-area in globals.css, which is what keeps content off them.
export const viewport: Viewport = {
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* min-w-0 so a long unbroken string in a child can't stretch the
            column past max-w-md — flex children default to min-width:auto. */}
        <main className="safe-area mx-auto flex min-h-screen w-full max-w-md min-w-0 flex-col gap-6 overflow-x-hidden">
          {children}
        </main>
      </body>
    </html>
  );
}
