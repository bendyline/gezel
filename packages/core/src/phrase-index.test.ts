import { describe, expect, it } from 'vitest';
import { PhraseIndex, normalizePhraseText } from './phrase-index.js';

function index(phrases: string[], minLength?: number) {
  return new PhraseIndex(
    phrases.map((phrase) => ({ phrase, value: phrase })),
    minLength === undefined ? {} : { minLength },
  );
}

/** The per-phrase regex the craftbook trigger route used before the index. */
function regexLongest(text: string, phrases: string[], minLength: number): string | null {
  const haystack = normalizePhraseText(text);
  let best: string | null = null;
  for (const raw of phrases) {
    const phrase = normalizePhraseText(raw);
    if (phrase.length < minLength || (best && phrase.length <= best.length)) continue;
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'u').test(haystack))
      best = phrase;
  }
  return best;
}

describe('PhraseIndex', () => {
  it('matches on word boundaries, case-insensitively', () => {
    const phrases = index(['changelog', 'meeting minutes']);
    expect(phrases.matches('Update the CHANGELOG for 1.2')).toEqual([
      { phrase: 'changelog', value: 'changelog' },
    ]);
    expect(phrases.matches('I keep change logging everything')).toEqual([]);
    expect(phrases.matches('changelogs everywhere')).toEqual([]);
    expect(phrases.matches('(meeting minutes)')).toHaveLength(1);
  });

  it('normalizes apostrophes and whitespace on both sides', () => {
    const phrases = index(['what’s   new']);
    expect(phrases.matches("Tell me what's\nnew this week")).toHaveLength(1);
  });

  it('prefers the longest phrase, and the first one added on a tie', () => {
    const phrases = new PhraseIndex([
      { phrase: 'draft a post', value: 'first' },
      { phrase: 'draft a post about', value: 'longer' },
      { phrase: 'DRAFT A POST', value: 'tie' },
    ]);
    expect(phrases.longest('please draft a post about our launch')?.value).toBe('longer');
    expect(phrases.longest('please draft a post')?.value).toBe('first');
    expect(phrases.longest('nothing here')).toBeNull();
  });

  it('returns each phrase once, in the order added', () => {
    const phrases = index(['seattle', 'pike place', 'space needle']);
    expect(
      phrases.matches('Space Needle, then Pike Place, then back to Seattle and the Space Needle'),
    ).toEqual([
      { phrase: 'seattle', value: 'seattle' },
      { phrase: 'pike place', value: 'pike place' },
      { phrase: 'space needle', value: 'space needle' },
    ]);
  });

  it('skips phrases shorter than the minimum', () => {
    expect(index(['log', 'changelog'], 6).matches('the log and the changelog')).toEqual([
      { phrase: 'changelog', value: 'changelog' },
    ]);
  });

  it('matches phrases that open on punctuation', () => {
    const phrases = index(['.net']);
    expect(phrases.matches('We ship on .NET 8')).toHaveLength(1);
    expect(phrases.matches('asp.net core')).toEqual([]);
    expect(phrases.matches('.netty')).toEqual([]);
  });

  it('treats accented letters as part of a word', () => {
    const phrases = index(['café']);
    expect(phrases.matches('Café au lait')).toHaveLength(1);
    expect(phrases.matches('two cafés')).toEqual([]);
  });

  it('agrees with the per-phrase regex it replaced', () => {
    const phrases = [
      'meeting minutes',
      'write up meeting notes',
      'action items list',
      'draft a social post',
      'draft a post about',
      'changelog',
      'turn a page into JSON',
      'kpi dashboard',
      'c++ refactor',
      'e-mail campaign',
      '/plan',
      'pwa',
    ];
    const texts = [
      'Can you write up Meeting Notes from today?',
      'please draft a post about our launch',
      'I keep change logging everything',
      'turn a page into json, then a KPI dashboard',
      'do a c++ refactor of the parser',
      'plan an e-mail campaign',
      'make it a pwa /plan',
      'meeting minutesx and action items list.',
      '',
    ];
    const indexed = index(phrases, 6);
    for (const text of texts) {
      const hit = indexed.longest(text);
      expect(hit ? normalizePhraseText(hit.phrase) : null, text).toBe(
        regexLongest(text, phrases, 6),
      );
    }
  });
});
