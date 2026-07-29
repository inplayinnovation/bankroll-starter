import type { NextConfig } from 'next';

// `npm run bankroll` serves the dev server through a Cloudflare tunnel so the
// app can be opened on a phone, which makes hot-reload requests cross-origin —
// and Next blocks those by default.
//
// A wildcard, because there is no moment at which this file could know the exact
// host: next.config is read when the dev server boots, and the tunnel is raised
// after it, so the CLI can read the manifest and put the app's launch path in
// the QR. Naming one host would mean going back to raising the tunnel first,
// which costs more than it buys.
//
// allowedDevOrigins does nothing outside `next dev`, so what this widens is a
// development machine's hot-reload endpoint, and only to other quick tunnels.
const nextConfig: NextConfig = {
  allowedDevOrigins: ['*.trycloudflare.com'],
};

export default nextConfig;
