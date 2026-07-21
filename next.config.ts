import type { NextConfig } from 'next';

// `npm run bankroll` serves the dev server through a Cloudflare tunnel so the
// app can be opened on a phone, which makes hot-reload requests cross-origin —
// and Next blocks those by default. The tunnel hostname is freshly assigned on
// every run, so it can't be hardcoded; the dev script passes it through this
// variable, and only that exact host is trusted.
const tunnelHost = process.env.BANKROLL_DEV_TUNNEL_ORIGIN
  ? new URL(process.env.BANKROLL_DEV_TUNNEL_ORIGIN).host
  : null;

const nextConfig: NextConfig = {
  allowedDevOrigins: tunnelHost ? [tunnelHost] : undefined,
};

export default nextConfig;
