import { sanitizePresentationSvg } from '@bendyline/gezel/svg';

/** Backward-compatible name for catalog callers and focused UI tests. */
export function sanitizeCatalogSvg(raw: string): string | null {
  return sanitizePresentationSvg(raw);
}
