/**
 * Per-gezel chat-bubble fonts. Each entry is one of the self-hosted WOFF2
 * families declared in packages/ui/src/assets/fonts/fonts.css. Gezels store
 * the `id` (kebab-case) on their frontmatter; the UI resolves it back to a
 * CSS font-family via `resolveGezelFontFamily`. An unset or unknown id
 * falls through to the chat-bubble default (PT Serif — `.msg-body` rule
 * in styles.css).
 *
 * `scale` is an optional per-font size-adjustment factor (default 1):
 * different typefaces render at noticeably different visual sizes at the
 * same point size, so a font that looks oversized gets nudged down to sit
 * proportional to the rest. The UI multiplies the base chat font-size by
 * this factor (see `resolveGezelFontScale`).
 */
export const GEZEL_CHAT_FONTS = [
  { id: 'pt-serif', label: 'PT Serif (default)', family: `'PT Serif'` },
  { id: 'hanken-grotesk', label: 'Hanken Grotesk', family: `'Hanken Grotesk'` },
  { id: 'cormorant-garamond', label: 'Cormorant Garamond', family: `'Cormorant Garamond'` },
  { id: 'crimson-text', label: 'Crimson Text', family: `'Crimson Text'` },
  { id: 'dm-sans', label: 'DM Sans', family: `'DM Sans'` },
  { id: 'dm-serif-display', label: 'DM Serif Display', family: `'DM Serif Display'` },
  { id: 'ibm-plex-sans', label: 'IBM Plex Sans', family: `'IBM Plex Sans'` },
  { id: 'inter', label: 'Inter', family: `'Inter'` },
  // JetBrains Mono runs large at a given point size; knock it down ~10% so
  // it reads proportional to the serif/sans options.
  { id: 'jetbrains-mono', label: 'JetBrains Mono', family: `'JetBrains Mono'`, scale: 0.9 },
  { id: 'lora', label: 'Lora', family: `'Lora'` },
  { id: 'merriweather', label: 'Merriweather', family: `'Merriweather'` },
  { id: 'oswald', label: 'Oswald', family: `'Oswald'` },
  { id: 'playfair-display', label: 'Playfair Display', family: `'Playfair Display'` },
  { id: 'roboto', label: 'Roboto', family: `'Roboto'` },
  { id: 'source-serif-4', label: 'Source Serif', family: `'Source Serif 4'` },
] as const;

export type GezelFont = (typeof GEZEL_CHAT_FONTS)[number];
export type GezelFontId = GezelFont['id'];

export function resolveGezelFontFamily(id: string | undefined | null): string | undefined {
  if (!id) return undefined;
  return GEZEL_CHAT_FONTS.find((f) => f.id === id)?.family;
}

/**
 * Per-font size-adjustment factor. Returns 1 for an unset / unknown id or
 * any font that doesn't declare a `scale`, so callers can multiply
 * unconditionally.
 */
export function resolveGezelFontScale(id: string | undefined | null): number {
  if (!id) return 1;
  const font = GEZEL_CHAT_FONTS.find((f) => f.id === id);
  return (font && 'scale' in font ? font.scale : undefined) ?? 1;
}
