/* The file pane's own glyphs, drawn to the contract its view-mode keys use
   (FileViewModeKeys): one 16 viewBox, one stroke weight, `currentColor`. The
   create actions were Font Awesome solids until they shared a header with
   those outlines, where a filled glyph read as a different kit. */
const GLYPH_PROPS = {
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  focusable: false,
} as const;

export function NewFolderGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg {...GLYPH_PROPS} width={size} height={size} aria-hidden="true">
      <path d="M1.8 4.6h3.6l1.4 1.5h7.4v6.9H1.8Z" />
      <path d="M8 7.8v3.4M6.3 9.5h3.4" strokeWidth="1.4" />
    </svg>
  );
}

export function NewFileGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg {...GLYPH_PROPS} width={size} height={size} aria-hidden="true">
      <path d="M9.3 2.2H3.9v11.6h8.2V5Z" />
      <path d="M9.3 2.2V5h2.8" strokeWidth="1.3" />
      <path d="M8 7.6v3.4M6.3 9.3h3.4" strokeWidth="1.4" />
    </svg>
  );
}

/** The fold chevron: left hides the tree, right brings it back. */
export function FoldChevronGlyph({
  direction,
  size = 12,
}: {
  direction: 'left' | 'right';
  size?: number;
}) {
  return (
    <svg {...GLYPH_PROPS} width={size} height={size} aria-hidden="true">
      <path d={direction === 'left' ? 'M10 3.5 5.5 8 10 12.5' : 'M6 3.5 10.5 8 6 12.5'} />
    </svg>
  );
}
