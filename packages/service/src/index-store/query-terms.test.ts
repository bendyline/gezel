import { describe, expect, it } from 'vitest';
import { queryTerms, searchTokens, textMatchesAnyTerm, tokenizeText } from './query-terms.js';

describe('queryTerms', () => {
  it('keeps only the distinctive words of an ordinary request', () => {
    // The France PowerPoint turn. Every dropped token matched 25-66 rows of
    // the shared library; the one that mattered matched none of them.
    expect(queryTerms('Can you create a PowerPoint about France')).toEqual([
      'powerpoint',
      'france',
    ]);
  });

  it('drops question scaffolding but keeps the subject', () => {
    expect(queryTerms('What did we decide about the invoice reconciliation?')).toEqual([
      'decide',
      'invoice',
      'reconciliation',
    ]);
  });

  it('keeps work verbs that name real work', () => {
    // `create`/`make` are how a user says "produce a thing" and carry no
    // subject; these name something a codebase actually contains.
    expect(queryTerms('build fix read write update delete show')).toEqual([
      'build',
      'fix',
      'read',
      'write',
      'update',
      'delete',
      'show',
    ]);
  });

  it('falls back to every token when the query is nothing but stopwords', () => {
    // Otherwise a bare "create" or "how to" would search for nothing at all.
    expect(queryTerms('create')).toEqual(['create']);
    expect(queryTerms('how to')).toEqual(['how', 'to']);
  });

  it('lowercases and dedupes before capping, and caps at 16 terms', () => {
    expect(queryTerms('Deck deck DECK')).toEqual(['deck']);
    const many = Array.from({ length: 30 }, (_, i) => `term${i}`).join(' ');
    expect(queryTerms(many)).toHaveLength(16);
  });

  it('returns nothing for a query with no word characters', () => {
    expect(queryTerms('   ***   ')).toEqual([]);
  });
});

describe('searchTokens', () => {
  it('folds plurals so a query and a body of text agree', () => {
    expect(searchTokens('invoices')).toEqual(new Set(['invoice']));
    // Short words keep their `s` — `has`/`its` are not plurals.
    expect(searchTokens('bus')).toEqual(new Set(['bus']));
  });

  it('shares one stopword list with the FTS query builder', () => {
    expect(searchTokens('can you create a deck about France')).toEqual(new Set(['deck', 'france']));
  });
});

describe('textMatchesAnyTerm', () => {
  it('mirrors the FTS prefix rule: three characters or more match as a prefix', () => {
    expect(textMatchesAnyTerm('the presentation is ready', ['present'])).toBe(true);
    expect(textMatchesAnyTerm('presentation', ['pre'])).toBe(true);
  });

  it('matches on token boundaries, never mid-word', () => {
    // `"sent"*` must not be satisfied by "presentation".
    expect(textMatchesAnyTerm('presentation', ['sent'])).toBe(false);
  });

  it('requires an exact match for terms under three characters', () => {
    expect(textMatchesAnyTerm('go to the store', ['go'])).toBe(true);
    expect(textMatchesAnyTerm('golang rocks', ['go'])).toBe(false);
  });

  it('is false when no term appears, and when there are no terms', () => {
    expect(textMatchesAnyTerm('a career memoir about Yammer', ['powerpoint', 'france'])).toBe(
      false,
    );
    expect(textMatchesAnyTerm('anything at all', [])).toBe(false);
  });
});

describe('tokenizeText', () => {
  it('splits on non-word characters and normalizes case', () => {
    expect(tokenizeText('Foo-Bar_baz.qux')).toEqual(['foo', 'bar_baz', 'qux']);
  });
});
