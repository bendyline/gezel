import { PROJECT_SHADOW_DIR_NAME } from './paths.js';

/**
 * True for artifacts-relative paths inside the reserved `shadow/` subtree —
 * gezel's derived cache of workspace shadow files (converted documents, image
 * descriptions, audio transcripts). Writes there are denied everywhere the
 * artifacts tree is user- or gezel-writable: only the indexer's own converter
 * produces shadow content, and it bypasses the artifact store entirely.
 *
 * Mirrors the connector-corpus predicate: segments are normalized and `..`
 * collapsed so `./shadow/x`, `shadow\\x`, and `docs/../shadow/x` all match.
 */
export function isReservedShadowArtifactPath(path: string): boolean {
  const segments = path
    .replaceAll('\\', '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');
  const collapsed: string[] = [];
  for (const segment of segments) {
    if (segment === '..') collapsed.pop();
    else collapsed.push(segment);
  }
  return collapsed[0]?.toLowerCase() === PROJECT_SHADOW_DIR_NAME;
}
