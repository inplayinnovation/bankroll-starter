'use client';

// The phone's vibration, through the Bankroll host. Every tap and every game
// moment calls it: a button, a tab, a choice, a pin that lands, a round that
// ends. haptics() never rejects and does nothing in a plain browser, so it
// gates nothing. See AGENTS.md, "Haptics".
import type { HapticType } from '@joinbankroll/sdk';

import { bankroll } from '@/lib/client/bankroll';

export type { HapticType };

/** One vibration. 'selection' is the finest tick, for a tap that changes a value or a tab. */
export function buzz(type: HapticType = 'selection'): void {
  void bankroll.haptics({ type });
}
