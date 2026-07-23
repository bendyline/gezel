/**
 * Inline workshop glyphs for the home screen. 24×24 grid, 1.8 stroke,
 * round caps/joins — recreated from the design handoff's "Assets" section.
 * No external image files.
 */

export function SproutGlyph({
  size = 18,
  color = 'var(--sage-deep)',
}: {
  size?: number;
  color?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 21 V11" />
      <path
        d="M12 14.4 C8.5 14.4 6.4 11.9 6.4 8.4 C9.9 8.4 12 10.9 12 14"
        fill={color}
        fillOpacity={0.18}
      />
      <path
        d="M12 12.4 C15.5 12.4 17.6 9.9 17.6 6.4 C14.1 6.4 12 8.9 12 12"
        fill={color}
        fillOpacity={0.18}
      />
    </svg>
  );
}

/**
 * The workbench glyph — the chosen home-tab icon (a thick top plank, two
 * legs, a stretcher, and a small workpiece). Kept available for the
 * greeting/tour, though the app chrome's home tab lives in App.tsx.
 */
export function WorkbenchGlyph({
  size = 14,
  color = 'var(--terra-deep)',
}: {
  size?: number;
  color?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 10 H21" strokeWidth={2.6} />
      <path d="M6 10.5 V20" />
      <path d="M18 10.5 V20" />
      <path d="M6 16 H18" />
      <rect
        x={10}
        y={6}
        width={4}
        height={3.2}
        rx={0.6}
        fill={color}
        fillOpacity={0.22}
        stroke="none"
      />
    </svg>
  );
}
