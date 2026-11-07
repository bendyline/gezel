/**
 * Glyphs for the message action keys, drawn to SectionIcon's rules: 24×24,
 * stroke-only, `currentColor`. Opening a saved reply uses SectionIcon's
 * artifacts drawer, where the reply was saved.
 */
export function MessageActionIcon({ name }: { name: 'save' | 'details' }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {name === 'save' ? (
        // Floppy disk
        <>
          <path d="M5 3h11.5L21 7.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
          <path d="M8 3v5h7V3" />
          <path d="M7 21v-6.5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1V21" />
        </>
      ) : (
        // A list of steps
        <>
          <circle cx="5" cy="6.5" r="1" />
          <circle cx="5" cy="12" r="1" />
          <circle cx="5" cy="17.5" r="1" />
          <path d="M9.5 6.5h10M9.5 12h10M9.5 17.5h6.5" />
        </>
      )}
    </svg>
  );
}
