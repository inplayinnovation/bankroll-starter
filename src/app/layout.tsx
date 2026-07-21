import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'Bankroll Starter',
  description: 'A real-money app built on Bankroll',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* min-w-0 so a long unbroken string in a child can't stretch the
            column past max-w-md — flex children default to min-width:auto. */}
        <main className="mx-auto flex min-h-screen w-full max-w-md min-w-0 flex-col gap-6 overflow-x-hidden px-5 py-10">
          {children}
        </main>
      </body>
    </html>
  );
}
