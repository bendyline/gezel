import {
  type SearchProvider,
  type SearchProviderInput,
  type SearchResult,
  safeDomain,
} from './types.js';

/**
 * Brave Search backend. Free tier: 2000 queries/month, 1 query/sec.
 * Requires an API key (see Settings → Web search → Brave). When the
 * key is missing we set `unavailableReason` so the chained provider
 * can fall back; the route surfaces the message verbatim otherwise.
 *
 * Throttle is module-scoped because there's only ever one Brave
 * provider in a process and the rate limit is per API key.
 */

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const MIN_INTERVAL_MS = 1100; // Brave allows 1 req/sec; 1.1s gives headroom.

let lastBraveCallAt = 0;
let braveCallChain: Promise<void> = Promise.resolve();

interface BraveWebResultRaw {
  title?: string;
  url?: string;
  description?: string;
  page_age?: string;
}

interface BraveSearchResponse {
  web?: { results?: BraveWebResultRaw[] };
}

export interface BraveSearchProviderOptions {
  apiKey: string | null;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
  /** Override for tests — disables module-scoped throttle. */
  disableThrottle?: boolean;
}

export class BraveSearchProvider implements SearchProvider {
  readonly name = 'brave' as const;
  readonly unavailableReason?: string;

  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly throttleEnabled: boolean;

  constructor(opts: BraveSearchProviderOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.throttleEnabled = !opts.disableThrottle;
    if (!opts.apiKey || opts.apiKey.length === 0) {
      this.unavailableReason =
        'Brave Search API key not configured (Settings → Web search → Brave).';
      this.apiKey = '';
    } else {
      this.apiKey = opts.apiKey;
    }
  }

  async search(input: SearchProviderInput, signal: AbortSignal): Promise<SearchResult[]> {
    if (this.unavailableReason) {
      throw new Error(this.unavailableReason);
    }

    const url = new URL(BRAVE_ENDPOINT);
    url.searchParams.set('q', input.query);
    url.searchParams.set('count', String(input.limit));
    if (input.freshness) {
      url.searchParams.set('freshness', mapFreshness(input.freshness));
    }
    if (input.country) url.searchParams.set('country', input.country);
    if (input.language) url.searchParams.set('search_lang', mapLanguage(input.language));

    if (this.throttleEnabled) await this.acquireThrottleSlot();

    const res = await this.fetchImpl(url.toString(), {
      headers: {
        'X-Subscription-Token': this.apiKey,
        Accept: 'application/json',
      },
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Brave search failed: HTTP ${res.status} ${res.statusText} ${text}`.trim());
    }
    const data = (await res.json()) as BraveSearchResponse;
    const raw = data.web?.results ?? [];
    return raw
      .filter(
        (r): r is BraveWebResultRaw & { title: string; url: string } =>
          typeof r.title === 'string' && typeof r.url === 'string',
      )
      .map((r) => {
        const out: SearchResult = {
          title: r.title,
          url: r.url,
          snippet: stripBraveSnippetMarkup(r.description ?? ''),
          domain: safeDomain(r.url),
          source: 'brave',
        };
        const age = parseIsoDate(r.page_age);
        if (age) out.publishedAt = age;
        return out;
      });
  }

  private async acquireThrottleSlot(): Promise<void> {
    // Chain throttled waits so concurrent calls serialize through one
    // queue instead of all sleeping for the same target instant.
    const wait = braveCallChain.then(async () => {
      const now = Date.now();
      const since = now - lastBraveCallAt;
      if (since < MIN_INTERVAL_MS) {
        await new Promise<void>((r) => setTimeout(r, MIN_INTERVAL_MS - since));
      }
      lastBraveCallAt = Date.now();
    });
    braveCallChain = wait.catch(() => {
      /* keep chain alive even if a previous waiter aborted */
    });
    await wait;
  }
}

/** Exported for unit tests. */
export function mapFreshness(v: 'day' | 'week' | 'month' | 'year'): string {
  switch (v) {
    case 'day':
      return 'pd';
    case 'week':
      return 'pw';
    case 'month':
      return 'pm';
    case 'year':
      return 'py';
  }
}

/** Brave wants the language portion only (no region tag). */
export function mapLanguage(language: string): string {
  return language.split('-')[0]?.toLowerCase() ?? language;
}

/** Brave snippets contain `<strong>`/`<b>` markers. Strip to plain text. */
export function stripBraveSnippetMarkup(snippet: string): string {
  return snippet
    .replace(/<\/?(?:strong|b|em|i)\b[^>]*>/gi, '')
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

function parseIsoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString();
}

/** Test-only reset of the module-scoped throttle. Not exported through index. */
export function _resetBraveThrottleForTests(): void {
  lastBraveCallAt = 0;
  braveCallChain = Promise.resolve();
}
