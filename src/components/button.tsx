'use client';

import type { ButtonHTMLAttributes } from 'react';

import { buzz, type HapticType } from '@/lib/client/haptics';

/**
 * A button that buzzes when tapped, so a screen built from it cannot forget
 * haptics. `tone` is the vibration: 'light' for a tap that does something,
 * 'selection' for one that picks something. Styling is the `.btn` class.
 */
export function Button({
  tone = 'light',
  className,
  onClick,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: HapticType }) {
  return (
    <button
      type="button"
      className={className ?? 'btn'}
      onClick={(event) => {
        buzz(tone);
        onClick?.(event);
      }}
      {...rest}
    />
  );
}
