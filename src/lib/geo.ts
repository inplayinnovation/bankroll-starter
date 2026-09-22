// Server-side policy. Pass geo from getSession(), never a browser-supplied location.
const GEO_CODE = /^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/;

/** Exact matches: US blocks country-only US; US-ME blocks Maine. */
export function isGeoBlocked(geo: string | null | undefined): boolean {
  const blocked = (process.env.BANKROLL_GEO_BLOCKLIST ?? '')
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean);
  if (blocked.length === 0) return false;
  if (blocked.some((code) => !GEO_CODE.test(code)))
    throw new Error('BANKROLL_GEO_BLOCKLIST must contain comma-separated codes such as US,US-ME');

  const location = geo?.trim().toUpperCase();
  // A configured restriction requires a usable, verified location.
  return !location || !GEO_CODE.test(location) || blocked.includes(location);
}
