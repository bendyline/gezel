import {
  type SearchProvider,
  type SearchProviderInput,
  type SearchResult,
  safeDomain,
} from './types.js';

/**
 * Wikipedia search backend — zero-key, always available. Serves as the
 * default when nothing else is configured. Great for factual queries;
 * narrow surface (one corpus per language) is the trade-off vs the
 * keyed providers.
 *
 * Uses the public action API:
 *   https://<lang>.wikipedia.org/w/api.php?action=query&list=search
 *
 * Honors `language` (swapped into the host); ignores `freshness` and
 * `country` since the corpus is timeless and language-bound.
 */

const DEFAULT_LANGUAGE = 'en';

interface WikipediaSearchHit {
  title?: string;
  snippet?: string;
  timestamp?: string;
}

interface WikipediaSearchResponse {
  query?: {
    search?: WikipediaSearchHit[];
  };
}

export interface WikipediaSearchProviderOptions {
  /** Override for tests. */
  fetchImpl?: typeof fetch;
  /** Override for tests. */
  userAgent?: string;
}

export class WikipediaSearchProvider implements SearchProvider {
  readonly name = 'wikipedia' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(opts: WikipediaSearchProviderOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.userAgent =
      opts.userAgent ?? 'Gezel/1.0 (+https://github.com/bendyline/gezel) web_search MCP tool';
  }

  async search(input: SearchProviderInput, signal: AbortSignal): Promise<SearchResult[]> {
    const lang = pickLanguage(input.language);
    const host = `${lang}.wikipedia.org`;
    const url = new URL(`https://${host}/w/api.php`);
    url.searchParams.set('action', 'query');
    url.searchParams.set('list', 'search');
    url.searchParams.set('format', 'json');
    url.searchParams.set('utf8', '1');
    url.searchParams.set('origin', '*');
    url.searchParams.set('srsearch', input.query);
    url.searchParams.set('srlimit', String(input.limit));

    const res = await this.fetchImpl(url.toString(), {
      headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
      signal,
    });
    if (!res.ok) {
      throw new Error(`Wikipedia search failed: HTTP ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as WikipediaSearchResponse;
    const hits = data.query?.search ?? [];
    return hits
      .filter((h): h is WikipediaSearchHit & { title: string } => typeof h.title === 'string')
      .map((h) => {
        const articleUrl = `https://${host}/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`;
        const out: SearchResult = {
          title: h.title,
          url: articleUrl,
          snippet: stripWikipediaSnippetMarkup(h.snippet ?? ''),
          domain: safeDomain(articleUrl) || host,
          source: 'wikipedia',
        };
        if (h.timestamp) out.publishedAt = h.timestamp;
        return out;
      });
  }
}

function pickLanguage(language: string | undefined): string {
  if (!language) return DEFAULT_LANGUAGE;
  const code = language.split('-')[0]?.toLowerCase();
  if (!code || !/^[a-z]{2,3}$/.test(code)) return DEFAULT_LANGUAGE;
  return code;
}

/**
 * Wikipedia returns snippets with `<span class="searchmatch">…</span>`
 * around matched terms plus arbitrary HTML entities. Strip both — the
 * model gets plain text, no HTML noise.
 *
 * Exported for unit tests.
 */
export function stripWikipediaSnippetMarkup(snippet: string): string {
  return snippet
    .replace(/<\/?span[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
