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
 *
 * The same request also HYDRATES the top results with article lead text
 * (`generator=search` + `prop=extracts`), because the obvious alternative
 * does not work. Telling the model to `fetch_url` a Wikipedia article
 * returns the rendered page — 2.1 MB for `/wiki/Italy` — of which the MCP
 * bridge's 80k-char cap admits only the `<head>`, inline JS, and nav
 * chrome. The article's lead sentence is not within the first 80k
 * characters, so that path costs a full tool round-trip and ~20k tokens
 * and yields zero facts. Joining search and extract server-side costs one
 * request and a few KB.
 */

const DEFAULT_LANGUAGE = 'en';

/**
 * How many of the ranked results get article text. The tail stays
 * snippet-only: a `limit: 20` search must not put twenty lead sections
 * into a small local model's context. Three covers the "read the top
 * hits" case that motivated hydration while staying inside a few
 * thousand tokens.
 */
const HYDRATED_RESULT_COUNT = 3;

/**
 * Per-article ceiling, enforced server-side via `exchars` so the daemon
 * doesn't pull text it will discard. Approximate by design — MediaWiki
 * cuts on a word boundary and appends an ellipsis.
 */
const EXTRACT_CHAR_CAP = 1200;

/** Ceiling for a full-article read when the caller doesn't pick one. */
export const DEFAULT_ARTICLE_CHAR_CAP = 24_000;

interface WikipediaSearchHit {
  title?: string;
  snippet?: string;
  timestamp?: string;
}

interface WikipediaPage {
  title?: string;
  extract?: string;
  fullurl?: string;
  /**
   * Rank assigned by `generator=search`. Load-bearing: `query.pages` is a
   * pageid-keyed OBJECT, not a ranked array, so its natural key order is
   * unrelated to relevance — a live `Italy` search returns `Italian`
   * (rank 3) ahead of `Italians` (rank 2). We key extracts by title and
   * take ordering from `query.search` instead, which is already ranked.
   */
  index?: number;
}

interface WikipediaSearchResponse {
  query?: {
    search?: WikipediaSearchHit[];
    pages?: Record<string, WikipediaPage>;
  };
}

export interface WikipediaSearchProviderOptions {
  /** Override for tests. */
  fetchImpl?: typeof fetch;
  /** Override for tests. */
  userAgent?: string;
}

export const WIKIPEDIA_USER_AGENT =
  'Gezel/1.0 (+https://github.com/bendyline/gezel) web_search MCP tool';

export class WikipediaSearchProvider implements SearchProvider {
  readonly name = 'wikipedia' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(opts: WikipediaSearchProviderOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.userAgent = opts.userAgent ?? WIKIPEDIA_USER_AGENT;
  }

  async search(input: SearchProviderInput, signal: AbortSignal): Promise<SearchResult[]> {
    const lang = pickLanguage(input.language);
    const host = `${lang}.wikipedia.org`;
    const url = new URL(`https://${host}/w/api.php`);
    url.searchParams.set('action', 'query');
    url.searchParams.set('format', 'json');
    url.searchParams.set('utf8', '1');
    url.searchParams.set('origin', '*');

    // Ranked hit list — the ordering and the match snippets.
    url.searchParams.set('list', 'search');
    url.searchParams.set('srsearch', input.query);
    url.searchParams.set('srlimit', String(input.limit));

    // Article text for those same hits, in the same round-trip. The
    // generator limit MUST match `srlimit`: the two run as separate
    // searches, and asking the generator for fewer gives it a different
    // top-N than the list. Measured at gsrlimit=3 against `Italy`, the
    // generator hydrated the list's #4 (a 24-char disambiguation stub)
    // and skipped its #3. Equal limits make both cover one title set;
    // `HYDRATED_RESULT_COUNT` then trims by the list's order below.
    url.searchParams.set('generator', 'search');
    url.searchParams.set('gsrsearch', input.query);
    url.searchParams.set('gsrlimit', String(input.limit));
    url.searchParams.set('prop', 'extracts|info');
    url.searchParams.set('inprop', 'url');
    url.searchParams.set('explaintext', '1');
    url.searchParams.set('exintro', '1');
    url.searchParams.set('exlimit', 'max');
    url.searchParams.set('exchars', String(EXTRACT_CHAR_CAP));

    const res = await this.fetchImpl(url.toString(), {
      headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
      signal,
    });
    if (!res.ok) {
      throw new Error(`Wikipedia search failed: HTTP ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as WikipediaSearchResponse;
    const hits = data.query?.search ?? [];
    const pages = pagesByTitle(data.query?.pages);

    return hits
      .filter((h): h is WikipediaSearchHit & { title: string } => typeof h.title === 'string')
      .map((h, idx) => {
        const page = pages.get(h.title);
        const articleUrl =
          page?.fullurl ?? `https://${host}/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`;
        const out: SearchResult = {
          title: h.title,
          url: articleUrl,
          snippet: stripWikipediaSnippetMarkup(h.snippet ?? ''),
          domain: safeDomain(articleUrl) || host,
          source: 'wikipedia',
        };
        if (h.timestamp) out.publishedAt = h.timestamp;
        const extract = idx < HYDRATED_RESULT_COUNT ? usefulExtract(page?.extract) : undefined;
        if (extract) out.content = extract;
        return out;
      });
  }
}

/**
 * Fetch one article's full plain text by exact title, following redirects
 * so a search result's title resolves even when it's an alias.
 *
 * Separate from {@link WikipediaSearchProvider.search} because full
 * articles do not fit a search response — English `Italy` is ~96 KB of
 * plain text on its own, over the bridge's whole-result cap. Hydration
 * gives every top hit a lead section; this gives one article in depth.
 */
export async function fetchWikipediaArticle(
  input: { title: string; language?: string; maxChars?: number },
  signal: AbortSignal,
  opts: WikipediaSearchProviderOptions = {},
): Promise<{ title: string; url: string; content: string; truncated: boolean }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const userAgent = opts.userAgent ?? WIKIPEDIA_USER_AGENT;
  const lang = pickLanguage(input.language);
  const host = `${lang}.wikipedia.org`;
  const maxChars = input.maxChars ?? DEFAULT_ARTICLE_CHAR_CAP;

  const url = new URL(`https://${host}/w/api.php`);
  url.searchParams.set('action', 'query');
  url.searchParams.set('format', 'json');
  url.searchParams.set('utf8', '1');
  url.searchParams.set('origin', '*');
  url.searchParams.set('titles', input.title);
  url.searchParams.set('redirects', '1');
  url.searchParams.set('prop', 'extracts|info');
  url.searchParams.set('inprop', 'url');
  url.searchParams.set('explaintext', '1');

  const res = await fetchImpl(url.toString(), {
    headers: { 'User-Agent': userAgent, Accept: 'application/json' },
    signal,
  });
  if (!res.ok) {
    throw new Error(`Wikipedia read failed: HTTP ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as WikipediaSearchResponse;
  const page = Object.values(data.query?.pages ?? {}).find(
    (p) => typeof p?.extract === 'string' && p.extract.trim() !== '',
  );
  if (!page) {
    throw new Error(
      `Wikipedia has no article text for ${JSON.stringify(input.title)} on ${host}. Check the exact title with wikipedia_search first.`,
    );
  }
  const title = page.title ?? input.title;
  const full = normalizeExtract(page.extract) ?? '';
  const truncated = full.length > maxChars;
  return {
    title,
    url: page.fullurl ?? `https://${host}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
    content: truncated ? full.slice(0, maxChars) : full,
    truncated,
  };
}

/**
 * Index generator pages by article title. Title is the only key shared
 * with `query.search`; the object's own keys are pageids, and its
 * iteration order does not track relevance (see {@link WikipediaPage.index}).
 */
function pagesByTitle(
  pages: Record<string, WikipediaPage> | undefined,
): Map<string, WikipediaPage> {
  const out = new Map<string, WikipediaPage>();
  for (const page of Object.values(pages ?? {})) {
    if (typeof page?.title === 'string') out.set(page.title, page);
  }
  return out;
}

/**
 * Below this, a search hit's extract is not worth its tokens.
 * Disambiguation pages come back as a few words ("Italian(s) may refer
 * to:"), which reads as less informative than the keyword snippet it
 * would be replacing.
 *
 * Scoped to search hydration on purpose. A full-article read must NOT
 * apply it: a genuinely short article is still the article the caller
 * asked for, and filtering there silently turns a valid read into empty
 * content.
 */
const MIN_USEFUL_EXTRACT_CHARS = 80;

function normalizeExtract(extract: string | undefined): string | undefined {
  if (typeof extract !== 'string') return undefined;
  const text = extract
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  return text === '' ? undefined : text;
}

/** Search-hydration variant: normalized, minus the stubs. */
function usefulExtract(extract: string | undefined): string | undefined {
  const text = normalizeExtract(extract);
  if (!text || text.length < MIN_USEFUL_EXTRACT_CHARS) return undefined;
  return text;
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
