/**
 * Whether an artifacts-drawer path is a connector's record: under `data/`,
 * with no path segment below it starting with `_` (the corpus's one mutable
 * surface, where drafts and sidecars live). Records are rewritten by their
 * connector on the next sync, so the person's editor opens them read-only;
 * the daemon and the MCP server keep their own write guards for gezels
 * (`isProtectedConnectorCorpusPath`), which this mirrors.
 */
export function isConnectorCorpusPath(artifactPath: string): boolean {
  const segments: string[] = [];
  for (const segment of artifactPath.replaceAll('\\', '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  if (segments[0]?.toLowerCase() === 'artifacts') segments.shift();
  if (segments[0]?.toLowerCase() !== 'data' || segments.length < 2) return false;
  return !segments.slice(1).some((segment) => segment.startsWith('_'));
}
