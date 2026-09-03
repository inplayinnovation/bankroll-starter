// What this app sells. One entry per thing a user can pay for, priced in whole
// US cents. The client names an item; the server looks the price up here, mints
// the charge for it, and checks the settled amount against it — so a price
// lives in exactly one place and the request body never carries one.
//
// The starter sells one thing: a demo charge of a cent, the smallest real
// amount, because every charge here moves actual money.
export interface Item {
  /** Shown on the pay sheet. */
  name: string;
  amountCents: number;
}

export const DEMO_ITEM = 'demo';

export const CATALOG: Record<string, Item> = {
  [DEMO_ITEM]: { name: 'Demo charge', amountCents: 1 },
};

export function itemFor(id: string): Item | null {
  return Object.prototype.hasOwnProperty.call(CATALOG, id) ? CATALOG[id]! : null;
}
