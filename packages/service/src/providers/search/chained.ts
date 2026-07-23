import type {
  SearchProvider,
  SearchProviderInput,
  SearchProviderName,
  SearchResult,
} from './types.js';

/**
 * Wrap a primary search provider with a fallback. Falls back ONLY when:
 *   - the primary has `unavailableReason` set (e.g. missing key), or
 *   - `search()` throws (transport error, upstream 5xx, auth failure).
 *
 * A 0-result response from the primary is *not* a fallback trigger —
 * "no matches" is a valid answer, and trying the fallback would be
 * surprising (it would change which corpus answered the query).
 */
export class ChainedSearchProvider implements SearchProvider {
  readonly name: SearchProviderName;
  readonly unavailableReason?: string;

  constructor(
    private readonly primary: SearchProvider,
    private readonly fallback: SearchProvider,
  ) {
    this.name = primary.name;
    if (primary.unavailableReason && fallback.unavailableReason) {
      this.unavailableReason = `Primary (${primary.name}) and fallback (${fallback.name}) both unavailable. Primary: ${primary.unavailableReason}`;
    }
  }

  async search(input: SearchProviderInput, signal: AbortSignal): Promise<SearchResult[]> {
    if (this.primary.unavailableReason) {
      return this.fallback.search(input, signal);
    }
    try {
      return await this.primary.search(input, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      return this.fallback.search(input, signal);
    }
  }
}
