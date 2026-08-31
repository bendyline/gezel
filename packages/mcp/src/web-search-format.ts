/**
 * Rendering for `web_search` / `wikipedia_search` results.
 *
 * Extracted from the server module so it can be unit-tested: importing
 * `server.ts` registers every tool as a side effect, so nothing under test
 * can pull a helper out of it.
 */

export interface FormattableSearchResult {
  title: string;
  url: string;
  snippet: string;
  domain: string;
  publishedAt?: string;
  source: string;
  content?: string;
}

export interface FormattableSearchResponse {
  results: FormattableSearchResult[];
  source: string;
  query: string;
  durationMs: number;
}

/**
 * Format a `web_search` API response as a numbered markdown list. Each
 * entry surfaces title, domain, optional date, body text, and URL on its
 * own line — domain on the header so the model can scan for credibility,
 * URL last so it's trivially copy-pasteable into `fetch_url`. The
 * footer states which backend answered so the model can weight results
 * accordingly (Wikipedia → encyclopedic, Brave → current).
 *
 * A result that carries `content` renders that INSTEAD of its snippet,
 * not in addition to it. For a hydrated Wikipedia hit the two overlap
 * almost entirely — the snippet is a keyword-match fragment cut out of
 * the same lead section — so printing both would spend tokens restating
 * a strictly worse version of the text directly above it.
 */
export function formatWebSearchResponse(res: FormattableSearchResponse): string {
  const SNIPPET_CAP = 280;
  /**
   * Higher than SNIPPET_CAP because hydrated body text is the point of
   * the entry, not a preview of it. Sits just above the provider's own
   * per-article ceiling so a full extract renders intact and this cap
   * only catches a backend that ignores that ceiling.
   */
  const CONTENT_CAP = 1400;
  const count = res.results.length;
  const header =
    count === 0
      ? `0 results from ${res.source} (query: ${JSON.stringify(res.query)}). Try broader terms.`
      : `${count} result${count === 1 ? '' : 's'} from ${res.source} (query: ${JSON.stringify(res.query)}) · ${res.durationMs}ms`;
  if (count === 0) return header;

  const hydrated = res.results.filter((r) => (r.content ?? '').trim() !== '').length;

  const entries = res.results.map((r, idx) => {
    const date = r.publishedAt ? `  ·  ${r.publishedAt.slice(0, 10)}` : '';
    const content = (r.content ?? '').trim();
    const body = content
      ? content.length > CONTENT_CAP
        ? `${content.slice(0, CONTENT_CAP - 1)}…`
        : content
      : r.snippet.length > SNIPPET_CAP
        ? `${r.snippet.slice(0, SNIPPET_CAP - 1)}…`
        : r.snippet;
    // Indent continuation lines so a multi-paragraph extract stays
    // visually inside its numbered entry instead of reading as prose
    // that escaped the list.
    const bodyLine = body ? `${body.replace(/\n+/g, '\n   ')}\n`.replace(/^/, '   ') : '';
    return `${idx + 1}. **${r.title}**  ·  ${r.domain}${date}\n${bodyLine}   ${r.url}`;
  });

  // Say plainly which entries already carry article text. Without this
  // the model cannot tell a hydrated entry from a snippet-only one, and
  // the safe assumption ("fetch them all") is the round-trip hydration
  // exists to avoid.
  const footer = hydrated
    ? `\n\nThe first ${hydrated === 1 ? 'result includes its' : `${hydrated} results include their`} article lead text above — no follow-up fetch needed to cite ${hydrated === 1 ? 'it' : 'them'}. For the full body of one article, call \`wikipedia_read\` with its exact title.`
    : '';
  return `${header}\n\n${entries.join('\n\n')}${footer}`;
}
