/**
 * The connector engine's own files inside a corpus: the corpus state
 * (`_meta.json`), a folder's listing cache (`_listing.json`), and the
 * per-folder read/flag sidecar (`_flags.json`). Gezels may not write them,
 * and file panels hide them until "show hidden files" is on.
 */
export const CONNECTOR_BOOKKEEPING_FILE_NAMES: readonly string[] = [
  '_meta.json',
  '_listing.json',
  '_flags.json',
];

const CONNECTOR_BOOKKEEPING_FILES = new Set(CONNECTOR_BOOKKEEPING_FILE_NAMES);

/** The segments below `data/` for an artifacts-drawer path, or null outside it. */
function corpusSegments(artifactPath: string): string[] | null {
  const segments: string[] = [];
  for (const segment of artifactPath.replaceAll('\\', '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  if (segments[0]?.toLowerCase() === 'artifacts') segments.shift();
  if (segments[0]?.toLowerCase() !== 'data') return null;
  return segments.slice(1);
}

/**
 * Whether an artifacts-drawer path is a connector's record: under `data/`,
 * with no path segment below it starting with `_` (the corpus's one mutable
 * surface, where drafts and sidecars live). Records are rewritten by their
 * connector on the next sync, so the person's editor opens them read-only;
 * the daemon and the MCP server keep their own write guards for gezels
 * (`isProtectedConnectorCorpusPath`), which this mirrors.
 */
export function isConnectorCorpusPath(artifactPath: string): boolean {
  const rest = corpusSegments(artifactPath);
  if (!rest || rest.length === 0) return false;
  return !rest.some((segment) => segment.startsWith('_'));
}

/**
 * Whether an artifacts-drawer path is one of
 * {@link CONNECTOR_BOOKKEEPING_FILE_NAMES} inside a corpus
 * (`data/<corpus>/**`). Outside `data/` the same name is an ordinary file.
 */
export function isConnectorBookkeepingPath(artifactPath: string): boolean {
  const rest = corpusSegments(artifactPath);
  if (!rest || rest.length < 2) return false;
  return CONNECTOR_BOOKKEEPING_FILES.has(rest[rest.length - 1]?.toLowerCase() ?? '');
}
