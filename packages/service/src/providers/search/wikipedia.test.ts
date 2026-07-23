import { describe, expect, it, vi } from 'vitest';
import { WikipediaSearchProvider, stripWikipediaSnippetMarkup } from './wikipedia.js';

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
