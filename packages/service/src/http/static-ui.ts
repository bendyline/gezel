import { extname } from 'node:path';

export const UI_DOCUMENT_CACHE_CONTROL = 'no-cache';
export const UI_IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * Vite content-hashes files below assets/, so they can be cached forever.
 * The HTML shell must revalidate because it names those hashed files.
 */
export function staticUiCacheControl(relativePath: string): string {
  return relativePath.startsWith('assets/')
    ? UI_IMMUTABLE_ASSET_CACHE_CONTROL
    : UI_DOCUMENT_CACHE_CONTROL;
}

/**
 * Only extensionless client routes receive the SPA shell. Returning
 * index.html for a missing script makes the browser report a misleading
 * module parse/fetch error and prevents stale-build recovery from seeing a
 * genuine 404.
 */
export function shouldServeUiShell(relativePath: string): boolean {
  if (relativePath === 'assets' || relativePath.startsWith('assets/')) return false;
  return relativePath === 'index.html' || extname(relativePath) === '';
}
