import type { Viewport } from 'next';

// Let the background reach the screen edges; .app-shell keeps the content
// inside the device's safe area. The public site has its own layout.
export const viewport: Viewport = {
  viewportFit: 'cover',
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="app-shell mx-auto flex min-h-screen w-full max-w-md min-w-0 flex-col gap-6 overflow-x-hidden">
      {children}
    </main>
  );
}
