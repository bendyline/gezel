import { sanitizePresentationSvg } from '@bendyline/gezel/svg';

/**
 * Backward-compatible service wrapper. The parser-backed implementation lives
 * in core so repository icons, catalog ingestion, rendering, and UI fallback
 * all enforce the same presentation-only grammar.
 */
export function sanitizeSvg(raw: string): string {
  return sanitizePresentationSvg(raw) ?? '';
}
