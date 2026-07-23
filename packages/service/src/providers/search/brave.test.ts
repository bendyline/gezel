import { describe, expect, it, vi } from 'vitest';
import {
  BraveSearchProvider,
  _resetBraveThrottleForTests,
  mapFreshness,
  mapLanguage,
  stripBraveSnippetMarkup,
} from './brave.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('BraveSearchProvider', () => {
  it('sets unavailableReason when key is missing', () => {
    const p = new BraveSearchProvider({ apiKey: null });
    expect(p.unavailableReason).toMatch(/Brave Search API key not configured/);
  });

  it('throws when invoked without a key', async () => {
    const p = new BraveSearchProvider({ apiKey: '' });
    await expect(p.search({ query: 'q', limit: 3 }, new AbortController().signal)).rejects.toThrow(
      /Brave Search API key not configured/,
    );
  });

  it('sends X-Subscription-Token and maps freshness/country/language', async () => {
    _resetBraveThrottleForTests();
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        web: {
          results: [
            {
              title: 'Headline',
              url: 'https://www.example.com/path',
              description: 'A <strong>relevant</strong> result.',
              page_age: '2026-04-20T12:00:00Z',
            },
          ],
        },
      }),
    );
    const p = new BraveSearchProvider({
      apiKey: 'test-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      disableThrottle: true,
    });
    const out = await p.search(
      {
        query: 'world news',
        limit: 5,
        freshness: 'week',
        country: 'us',
        language: 'en-US',
      },
      new AbortController().signal,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const firstCall = fetchImpl.mock.calls[0];
    if (!firstCall) throw new Error('expected fetch call');
    const [calledUrl, init] = firstCall;
    const url = new URL(String(calledUrl));
    expect(url.origin + url.pathname).toBe('https://api.search.brave.com/res/v1/web/search');
    expect(url.searchParams.get('q')).toBe('world news');
    expect(url.searchParams.get('count')).toBe('5');
    expect(url.searchParams.get('freshness')).toBe('pw');
    expect(url.searchParams.get('country')).toBe('us');
    expect(url.searchParams.get('search_lang')).toBe('en');
    const headers = (init as RequestInit | undefined)?.headers as Record<string, string>;
    expect(headers['X-Subscription-Token']).toBe('test-key');
    expect(out).toEqual([
      {
        title: 'Headline',
        url: 'https://www.example.com/path',
        snippet: 'A relevant result.',
        domain: 'www.example.com',
        publishedAt: '2026-04-20T12:00:00.000Z',
        source: 'brave',
      },
    ]);
  });

  it('throws an informative error on non-2xx', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response('quota', { status: 429, statusText: 'Too Many Requests' }),
    );
    const p = new BraveSearchProvider({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      disableThrottle: true,
    });
    await expect(p.search({ query: 'q', limit: 3 }, new AbortController().signal)).rejects.toThrow(
      /HTTP 429/,
    );
  });

  it('skips publishedAt when page_age is unparseable', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        web: {
          results: [
            { title: 'T', url: 'https://x.test/p', description: '', page_age: '3 days ago' },
          ],
        },
      }),
    );
    const p = new BraveSearchProvider({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      disableThrottle: true,
    });
    const out = await p.search({ query: 'q', limit: 1 }, new AbortController().signal);
    expect(out[0]).not.toHaveProperty('publishedAt');
  });
});

describe('Brave helpers', () => {
  it('maps freshness', () => {
    expect(mapFreshness('day')).toBe('pd');
    expect(mapFreshness('week')).toBe('pw');
    expect(mapFreshness('month')).toBe('pm');
    expect(mapFreshness('year')).toBe('py');
  });

  it('maps language to base code', () => {
    expect(mapLanguage('en-US')).toBe('en');
    expect(mapLanguage('NL')).toBe('nl');
    expect(mapLanguage('en')).toBe('en');
  });

  it('strips snippet markup', () => {
    expect(stripBraveSnippetMarkup('A <strong>bold</strong> &amp; <em>italic</em> bit')).toBe(
      'A bold & italic bit',
    );
  });
});
