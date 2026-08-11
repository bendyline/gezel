import { sanitizePresentationSvg } from '@bendyline/gezel/svg';

const STANDALONE_CURRENT_COLOR = '#e0b897';

/**
 * Convert arbitrary SVG input into a parser-sanitized, isolated image URL.
 * A standalone SVG image cannot inherit currentColor from the parent HTML
 * document, so provide the existing warm icon color at its root when absent.
 */
export function safeSvgImageUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const sanitized = sanitizePresentationSvg(raw);
  if (!sanitized) return null;
  const standalone = /^<svg\b[^>]*\scolor=/.test(sanitized)
    ? sanitized
    : sanitized.replace(/^<svg\b/, `<svg color="${STANDALONE_CURRENT_COLOR}"`);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(standalone)}`;
}
