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
    }));
  }
}
