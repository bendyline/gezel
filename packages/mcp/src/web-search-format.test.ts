import { describe, expect, it } from 'vitest';
import { type FormattableSearchResult, formatWebSearchResponse } from './web-search-format.js';

function result(over: Partial<FormattableSearchResult> = {}): FormattableSearchResult {
  return {
    title: 'Italy',
    url: 'https://en.wikipedia.org/wiki/Italy',
    snippet: 'A country in Southern Europe',
    domain: 'en.wikipedia.org',
    source: 'wikipedia',
    ...over,
  };
}

function render(results: FormattableSearchResult[], source = 'wikipedia'): string {
  return formatWebSearchResponse({ results, source, query: 'Italy', durationMs: 12 });
}

describe('formatWebSearchResponse', () => {
  it('reports an empty result set with a nudge instead of an empty list', () => {
    const out = render([]);
    expect(out).toContain('0 results');
    expect(out).toContain('Try broader terms');
  });

  it('renders the snippet when no article text came back', () => {
    const out = render([result()]);
    expect(out).toContain('A country in Southern Europe');
    expect(out).toContain('https://en.wikipedia.org/wiki/Italy');
  });

  it('renders content instead of the snippet, not in addition to it', () => {
    // The two overlap almost entirely for a hydrated Wikipedia hit — the
    // snippet is a fragment cut from the same lead section — so printing
    // both spends tokens restating a worse copy of the text above it.
    const out = render([
      result({ content: 'Italy, officially the Italian Republic, is a country.' }),
    ]);
    expect(out).toContain('Italy, officially the Italian Republic');
    expect(out).not.toContain('A country in Southern Europe');
  });

  it('does not treat whitespace-only content as hydrated', () => {
    const out = render([result({ content: '   \n  ' })]);
    expect(out).toContain('A country in Southern Europe');
    expect(out).not.toMatch(/lead text above/);
  });

  it('tells the model which results already carry article text', () => {
    const out = render([
      result({ title: 'Italy', content: 'Italy is a country in Europe.' }),
      result({ title: 'Italians', content: 'Italians are an ethnic group.' }),
      result({ title: 'Regions of Italy' }),
    ]);
    expect(out).toContain('The first 2 results include their article lead text');
    expect(out).toContain('wikipedia_read');
  });

  it('uses singular phrasing for a single hydrated result', () => {
    const out = render([result({ content: 'Italy is a country in Europe.' })]);
    expect(out).toContain('The first result includes its article lead text');
  });

  it('omits the hydration footer entirely when nothing was hydrated', () => {
    const out = render([result(), result({ title: 'Italians' })], 'brave');
    expect(out).not.toMatch(/lead text above/);
    expect(out).not.toContain('wikipedia_read');
  });

  it('caps an oversized snippet', () => {
    const out = render([result({ snippet: 'x'.repeat(400) })]);
    expect(out).toContain('…');
    expect(out).not.toContain('x'.repeat(400));
  });

  it('caps oversized content well above the snippet cap', () => {
    // Body text is the point of a hydrated entry, not a preview of it, so
    // it must not be clipped to the 280-char snippet ceiling.
    const out = render([result({ content: 'y'.repeat(2000) })]);
    expect(out).toContain('…');
    expect(out).toContain('y'.repeat(1000));
    expect(out).not.toContain('y'.repeat(1500));
  });

  it('keeps multi-paragraph content indented inside its numbered entry', () => {
    const out = render([result({ content: 'First para.\n\nSecond para.' })]);
    for (const line of out.split('\n')) {
      if (line.includes('Second para.')) expect(line).toMatch(/^ {3}/);
    }
  });

  it('numbers entries and preserves result order', () => {
    const out = render([
      result({ title: 'Italy' }),
      result({ title: 'Italians' }),
      result({ title: 'Kingdom of Italy' }),
    ]);
    expect(out.indexOf('1. **Italy**')).toBeGreaterThan(-1);
    expect(out.indexOf('2. **Italians**')).toBeGreaterThan(out.indexOf('1. **Italy**'));
    expect(out.indexOf('3. **Kingdom of Italy**')).toBeGreaterThan(out.indexOf('2. **Italians**'));
  });

  it('surfaces the publication date when the backend supplies one', () => {
    const out = render([result({ publishedAt: '2025-01-02T03:04:05Z' })]);
    expect(out).toContain('2025-01-02');
  });
});
