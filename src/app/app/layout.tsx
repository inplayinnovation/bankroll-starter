import type { Viewport } from 'next';

// Let the background reach the screen edges; .app-shell keeps the content
// inside the device's safe area. The public site has its own layout.
export const viewport: Viewport = {
  viewportFit: 'cover',
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="app-shell mx-auto flex h-dvh w-full max-w-md min-w-0 flex-col overflow-hidden">
      {children}
    </main>
  );
}
