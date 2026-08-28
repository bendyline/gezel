/**
 * Web-search backend abstraction. One method, normalized result shape —
 * the model never sees backend-specific quirks. Selected at runtime by
 * `createSearchProvider` based on config + env. See the sibling
 * `factory.ts` for selection rules.
 *
 * The provider lives service-side (not in the MCP subprocess) because
 * the route layer enforces query allow/deny policy and runs the
 * outbound credential-leak screen before invoking it.
 */

export type SearchProviderName = 'brave' | 'wikipedia' | 'tavily' | 'mock';

export interface SearchProviderInput {
  query: string;
  /** 1..20. Route normalizes; provider may return fewer. */
  limit: number;
  /** Restrict to recently-published pages. Honored by Brave; Wikipedia ignores. */
  freshness?: 'day' | 'week' | 'month' | 'year';
  /** ISO-3166 country bias (e.g. "us"). Brave-only. */
  country?: string;
  /** BCP-47 language code. Honored by Brave + Wikipedia. */
  language?: string;
}

export interface SearchResult {
  title: string;
  url: string;
  /** 1–3 sentences. May be empty when the backend doesn't supply one. */
  snippet: string;
  /** Hostname extracted from `url` for at-a-glance scanning. */
  domain: string;
  /** ISO 8601 when the backend supplies it. */
  publishedAt?: string;
  source: SearchProviderName;
  /**
   * Substantive plain-text body the backend returned with the hit. Only
   * Wikipedia sets it today: its API joins search + article extract in one
   * request, so hydrating costs no extra round-trip. Optional so Brave /
   * Tavily / mock stay untouched — consumers that only want a compact list
   * keep reading `snippet`.
   */
  content?: string;
}

export interface SearchProvider {
  readonly name: SearchProviderName;
  /**
   * Set when the provider can't be used right now (missing API key,
   * disabled by config). The route surfaces the message verbatim to
   * the model; the chained provider uses it to short-circuit to a
   * fallback. Distinct from `search()` throwing — those are transport
   * / upstream errors that can be retried.
   */
  readonly unavailableReason?: string;
  search(input: SearchProviderInput, signal: AbortSignal): Promise<SearchResult[]>;
}

/** Extract the hostname from a URL, or return an empty string when the URL is malformed. */
export function safeDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
