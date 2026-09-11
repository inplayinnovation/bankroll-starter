import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'Bankroll Starter',
  description: 'A real-money app built on Bankroll',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
