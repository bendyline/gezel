/**
 * Query-term highlighting for search result rows.
 *
 * Client-side on purpose: the service's snippets also feed model prompts, so
 * they stay clean text and the emphasis is added only where a person reads
 * them. Shared by the titlebar palette, the "See all results" overlay, and
 * the Documents library list so one query highlights identically everywhere.
 */

/** Wrap query-token matches in `<mark>`; returns the plain string when nothing matches. */
export function highlightTokens(text: string, query: string): React.ReactNode {
  const tokens = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [])];
  if (tokens.length === 0) return text;
  const pattern = new RegExp(
    `(${tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'giu',
  );
  const parts = text.split(pattern);
  if (parts.length === 1) return text;
  // Odd indices are the capture group — guaranteed by `String.split` with a
  // single capturing pattern. Decided by position, never by re-testing each
  // part: a `/g` regex carries `lastIndex` between calls, so re-testing makes
  // the result depend on what was tested before it.
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string; order never changes
      <mark key={i}>{part}</mark>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: see above
      <span key={i}>{part}</span>
    ),
  );
}
