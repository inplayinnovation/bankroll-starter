// Server policy defaults. A recipe can pass overrides to createP2P; every
// entry snapshots the resulting terms, including its no-show window.
export const ENTRY_CENTS = 100;
export const CREATOR_FEE_BPS = 1_000;
export const START_WINDOW_MS = 5 * 60_000;
export const CREATOR_FEE_CENTS = (ENTRY_CENTS * 2 * CREATOR_FEE_BPS) / 10_000;
export const PRIZE_CENTS = ENTRY_CENTS * 2 - CREATOR_FEE_CENTS;

export interface Policy {
  entryCents: number;
  creatorFeeBps: number;
  startWindowMs: number;
}
export const DEFAULT_POLICY: Readonly<Policy> = {
  entryCents: ENTRY_CENTS,
  creatorFeeBps: CREATOR_FEE_BPS,
  startWindowMs: START_WINDOW_MS,
};
export const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
