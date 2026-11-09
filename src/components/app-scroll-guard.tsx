'use client';

import { useEffect } from 'react';

/** The document stays still; only an explicitly marked region may scroll. */
export function AppScrollGuard() {
  useEffect(() => {
    let lastY: number | null = null;
    const start = (event: TouchEvent) => {
      lastY = event.touches.length === 1 ? event.touches[0].clientY : null;
    };
    const move = (event: TouchEvent) => {
      // This guard owns one-finger page panning, not pinch/zoom or game input.
      if (event.touches.length !== 1) {
        lastY = null;
        return;
      }
      const y = event.touches[0].clientY;
      const delta = lastY === null ? 0 : y - lastY;
      lastY = y;
      if (!event.cancelable) return;

      const target = event.target instanceof Element ? event.target : null;
      let region = target?.closest<HTMLElement>('[data-scroll]') ?? null;
      while (region) {
        const maximum = region.scrollHeight - region.clientHeight;
        const overflow = getComputedStyle(region).overflowY;
        if (
          /^(auto|scroll)$/.test(overflow) &&
          maximum > 1 &&
          ((delta > 0 && region.scrollTop > 0) || (delta < 0 && region.scrollTop < maximum - 1))
        )
          return;
        region = region.parentElement?.closest<HTMLElement>('[data-scroll]') ?? null;
      }

      // Empty lists and outward swipes at either edge must not reach the
      // webview's page bounce. Pointer events still reach the game's controls.
      event.preventDefault();
    };
    document.addEventListener('touchstart', start, { passive: true });
    document.addEventListener('touchmove', move, { passive: false });
    return () => {
      document.removeEventListener('touchstart', start);
      document.removeEventListener('touchmove', move);
    };
  }, []);
  return null;
}
