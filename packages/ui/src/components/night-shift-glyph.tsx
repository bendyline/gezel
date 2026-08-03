/**
 * The Night Shift moon, shared so every surface that refers to the shift
 * draws the same crescent. The header control
 * ([App.tsx](../App.tsx)'s `NightShiftMenu`) layers drifting clouds and a
 * glow on top of this path; quieter references — the queue popover's
 * scheduled-work section — use the bare glyph below.
 */

export const NIGHT_SHIFT_MOON_PATH =
  'M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-8.54-6.5A8.97 8.97 0 0 0 12 3z';

/** Static crescent at text size, for inline use beside a label. */
export function NightShiftMoonGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d={NIGHT_SHIFT_MOON_PATH} />
    </svg>
  );
}
