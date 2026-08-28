import type { SearchProvider, SearchProviderInput, SearchResult } from './types.js';

/**
 * Deterministic search backend for tests + `GEZEL_MOCK_PROVIDER=1`.
 * Returns a fixed three-entry seed list parameterized by the query —
 * enough that route + tool-formatting tests can assert exact output.
 */

const SEED: ReadonlyArray<{ host: string; path: string; description: string }> = [
  {
    host: 'example.com',
    path: '/a',
    description: 'First mock result. Useful for asserting the formatter handles one entry.',
  },
  {
    host: 'example.org',
    path: '/b',
    description:
      'Second mock result with a longer snippet that contains punctuation, dashes — and even quotes.',
  },
  {
    host: 'example.net',
    path: '/c',
    description: 'Third mock result. Tests pagination shape when limit < seed length.',
  },
];

export class MockSearchProvider implements SearchProvider {
  readonly name = 'mock' as const;

  // eslint-disable-next-line @typescript-eslint/require-await
  async search(input: SearchProviderInput, _signal: AbortSignal): Promise<SearchResult[]> {
    const slice = SEED.slice(0, Math.max(0, Math.min(input.limit, SEED.length)));
    return slice.map((s, idx) => ({
      title: `Mock result ${idx + 1} for "${input.query}"`,
      url: `https://${s.host}${s.path}`,
      snippet: s.description,
      domain: s.host,
      publishedAt: '2026-04-25T00:00:00.000Z',
      source: 'mock' as const,
      // Only the leading results carry body text, mirroring the real
      // Wikipedia provider's partial hydration so formatter tests
      // exercise both the hydrated and snippet-only branches.
      ...(idx === 0
        ? {
            content: `Mock article body for "${input.query}". Long enough to read as real prose rather than a snippet, so formatter tests can assert the hydrated branch renders a body block.`,
          }
        : {}),
    }));
  }
}

/**
 * Deterministic stand-in for {@link fetchWikipediaArticle} under
 * `GEZEL_MOCK_PROVIDER=1`. Exists so the `wikipedia_read` route has a
 * hermetic path: without it, every E2E and CI run of that route would
 * reach the live wikipedia.org, which is the one source the hermetic
 * research scenarios must never touch.
 */
export function mockWikipediaArticle(input: { title: string; maxChars?: number }): {
  title: string;
  url: string;
  content: string;
  truncated: boolean;
} {
  // Comfortably longer than the schema's 500-char `maxChars` floor, so a
  // caller asking for the minimum still exercises the truncation branch.
  const body = `Mock article body for "${input.title}". This deterministic text stands in for a Wikipedia extract so tests never reach the network. ${'It is padded to a realistic article length so truncation behavior is exercisable. '.repeat(8)}`;
  const max = input.maxChars ?? body.length;
  return {
    title: input.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(input.title.replace(/ /g, '_'))}`,
    content: body.slice(0, max),
    truncated: body.length > max,
  };
}
