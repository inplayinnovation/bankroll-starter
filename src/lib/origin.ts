// Everything origin-shaped derives from the deployment itself — the manifest's
// `sub`, and the audience the session token is verified against. Nothing to
// configure: the app is correct wherever it is deployed, including the first
// deploy when nobody has set anything up yet.
import { headers } from 'next/headers';

// Vercel exposes the project's stable production domain here; VERCEL_URL is the
// per-deployment URL (changes every push), so it's only the fallback.
function envOrigin(): string | null {
  const production = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (production) return `https://${production}`;
  const deployment = process.env.VERCEL_URL;
  if (deployment) return `https://${deployment}`;
  return null;
}

/**
 * The origin this app is served from. Prefers the request's own host so preview
 * deployments and custom domains identify themselves correctly.
 */
/**
 * Where this app can be reached from a phone.
 *
 * In development that isn't the request origin: a browser sees localhost, which
 * Bankroll can't open. `npm run bankroll` puts the tunnel origin here, so the
 * link on the landing page works from the laptop that generated it.
 */
export async function publicOrigin(): Promise<string> {
  return process.env.BANKROLL_DEV_TUNNEL_ORIGIN ?? (await getOrigin());
}

export async function getOrigin(): Promise<string> {
  const requestHeaders = await headers();
  const host = requestHeaders.get('host');
  if (host) {
    const protocol = host.startsWith('localhost') ? 'http' : 'https';
    return `${protocol}://${host}`;
  }
  return envOrigin() ?? 'http://localhost:3000';
}
