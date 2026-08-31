import { describe, expect, it, vi } from 'vitest';
import {
  WikipediaSearchProvider,
  fetchWikipediaArticle,
  stripWikipediaSnippetMarkup,
} from './wikipedia.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('WikipediaSearchProvider', () => {
  it('builds the correct request URL and maps results', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        query: {
          search: [
            {
              title: 'Example Article',
              snippet: 'An <span class="searchmatch">example</span> excerpt with &amp; entity.',
              timestamp: '2025-01-02T03:04:05Z',
            },
          ],
        },
      }),
    );
    const provider = new WikipediaSearchProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const ctrl = new AbortController();
    const results = await provider.search({ query: 'example query', limit: 5 }, ctrl.signal);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const firstCall = fetchImpl.mock.calls[0];
    const requestedUrl = firstCall ? String(firstCall[0]) : '';
    expect(requestedUrl).toContain('https://en.wikipedia.org/w/api.php');
    expect(requestedUrl).toContain('srsearch=example+query');
    expect(requestedUrl).toContain('srlimit=5');

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: 'Example Article',
      url: 'https://en.wikipedia.org/wiki/Example_Article',
      snippet: 'An example excerpt with & entity.',
      domain: 'en.wikipedia.org',
      publishedAt: '2025-01-02T03:04:05Z',
      source: 'wikipedia',
    });
  });

  it('switches host on the language hint', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ query: { search: [] } }));
    const provider = new WikipediaSearchProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.search({ query: 'q', limit: 3, language: 'nl' }, new AbortController().signal);
    const firstCall = fetchImpl.mock.calls[0];
    expect(firstCall ? String(firstCall[0]) : '').toContain('https://nl.wikipedia.org/w/api.php');
  });

  it('returns [] when query.search is missing', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({}));
    const provider = new WikipediaSearchProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await provider.search({ query: 'q', limit: 3 }, new AbortController().signal);
    expect(out).toEqual([]);
  });

  it('throws on non-2xx', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response('no', { status: 500, statusText: 'oops' }),
    );
    const provider = new WikipediaSearchProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      provider.search({ query: 'q', limit: 3 }, new AbortController().signal),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe('stripWikipediaSnippetMarkup', () => {
  it('strips <span class="searchmatch"> wrappers', () => {
    expect(stripWikipediaSnippetMarkup('Hello <span class="searchmatch">world</span>')).toBe(
      'Hello world',
    );
  });
  it('decodes common HTML entities', () => {
    expect(stripWikipediaSnippetMarkup('a &amp; b &quot;c&quot;')).toBe('a & b "c"');
  });
  it('collapses whitespace', () => {
    expect(stripWikipediaSnippetMarkup('  many   spaces  ')).toBe('many spaces');
  });
});

/**
 * Hydration coverage. The fixtures mirror the real API's response shape:
 * `query.search` is a ranked array, while `query.pages` is a pageid-keyed
 * object whose iteration order does NOT track relevance.
 */
describe('WikipediaSearchProvider hydration', () => {
  const longExtract = (label: string) =>
    `${`${label} is a country in Europe. `.repeat(6)}It has a long recorded history.`;

  function hydratedResponse() {
    return {
      query: {
        search: [
          { title: 'Italy', snippet: 'A <span class="searchmatch">country</span>' },
          { title: 'Italians', snippet: 'An ethnic group' },
          { title: 'Kingdom of Italy', snippet: 'A former state' },
          { title: 'Regions of Italy', snippet: 'Administrative divisions' },
        ],
        // Deliberately scrambled relative to the ranked list, and keyed by
        // pageid — this is what the live API actually returns.
        pages: {
          '9804204': {
            title: 'Kingdom of Italy',
            index: 3,
            extract: longExtract('The Kingdom of Italy'),
            fullurl: 'https://en.wikipedia.org/wiki/Kingdom_of_Italy',
          },
          '14532': {
            title: 'Italy',
            index: 1,
            extract: longExtract('Italy'),
            fullurl: 'https://en.wikipedia.org/wiki/Italy',
          },
          '385155': {
            title: 'Italians',
            index: 2,
            extract: longExtract('Italians'),
            fullurl: 'https://en.wikipedia.org/wiki/Italians',
          },
          '1898028': {
            title: 'Regions of Italy',
            index: 4,
            extract: longExtract('The regions of Italy'),
            fullurl: 'https://en.wikipedia.org/wiki/Regions_of_Italy',
          },
        },
      },
    };
  }

  async function search(body: unknown, limit = 10) {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(body));
    const provider = new WikipediaSearchProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const results = await provider.search({ query: 'Italy', limit }, new AbortController().signal);
    return { results, requestedUrl: String(fetchImpl.mock.calls[0]?.[0] ?? '') };
  }

  it('requests search and extracts in a single round-trip', async () => {
    const { requestedUrl } = await search(hydratedResponse());
    expect(requestedUrl).toContain('list=search');
    expect(requestedUrl).toContain('generator=search');
    expect(requestedUrl).toContain('explaintext=1');
    expect(requestedUrl).toContain('exintro=1');
  });

  it('asks the generator for the same limit as the list', async () => {
    // Divergent limits give the generator a different top-N than the list,
    // so it hydrates articles that are not the ones ranked highest.
    const { requestedUrl } = await search(hydratedResponse(), 7);
    expect(requestedUrl).toContain('srlimit=7');
    expect(requestedUrl).toContain('gsrlimit=7');
  });

  it('attaches extracts to the matching titles despite scrambled page order', async () => {
    const { results } = await search(hydratedResponse());
    expect(results.map((r) => r.title)).toEqual([
      'Italy',
      'Italians',
      'Kingdom of Italy',
      'Regions of Italy',
    ]);
    expect(results[0]?.content).toContain('Italy is a country');
    expect(results[1]?.content).toContain('Italians is a country');
    expect(results[2]?.content).toContain('The Kingdom of Italy is a country');
  });

  it('hydrates only the leading results, leaving the tail snippet-only', async () => {
    const { results } = await search(hydratedResponse());
    expect(results[3]?.content).toBeUndefined();
    expect(results[3]?.snippet).toBe('Administrative divisions');
  });

  it('prefers the canonical fullurl over a constructed one', async () => {
    const { results } = await search(hydratedResponse());
    expect(results[0]?.url).toBe('https://en.wikipedia.org/wiki/Italy');
  });

  it('drops stub extracts rather than spending tokens on them', async () => {
    const { results } = await search({
      query: {
        search: [{ title: 'Italian', snippet: 'may refer to' }],
        pages: { '14611': { title: 'Italian', index: 1, extract: 'Italian(s) may refer to:' } },
      },
    });
    expect(results[0]?.content).toBeUndefined();
  });

  it('still returns results when the response carries no extracts at all', async () => {
    const { results } = await search({
      query: { search: [{ title: 'Italy', snippet: 'A country' }] },
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBeUndefined();
    expect(results[0]?.url).toBe('https://en.wikipedia.org/wiki/Italy');
  });
});

describe('fetchWikipediaArticle', () => {
  const article = {
    query: {
      pages: {
        '14532': {
          title: 'Italy',
          extract: 'Italy is a country in Europe with a long history.',
          fullurl: 'https://en.wikipedia.org/wiki/Italy',
        },
      },
    },
  };

  it('requests the full body (no exintro) and follows redirects', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(article));
    await fetchWikipediaArticle({ title: 'Italy' }, new AbortController().signal, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const url = String(fetchImpl.mock.calls[0]?.[0] ?? '');
    expect(url).toContain('titles=Italy');
    expect(url).toContain('redirects=1');
    expect(url).toContain('explaintext=1');
    expect(url).not.toContain('exintro');
  });

  it('reports truncation when maxChars clips the body', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(article));
    const out = await fetchWikipediaArticle(
      { title: 'Italy', maxChars: 10 },
      new AbortController().signal,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(out.truncated).toBe(true);
    expect(out.content).toHaveLength(10);
  });

  it('returns the whole body untruncated when it fits', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(article));
    const out = await fetchWikipediaArticle({ title: 'Italy' }, new AbortController().signal, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.truncated).toBe(false);
    expect(out.title).toBe('Italy');
    expect(out.content).toContain('long history');
  });

  it('throws an actionable error when the title has no article', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ query: { pages: { '-1': { title: 'Nope' } } } }),
    );
    await expect(
      fetchWikipediaArticle({ title: 'Nope' }, new AbortController().signal, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/wikipedia_search/i);
  });
});
