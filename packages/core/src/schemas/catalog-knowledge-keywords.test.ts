import { describe, expect, it } from 'vitest';
import { PhraseIndex } from '../phrase-index.js';
import { KnowledgeCatalogKeywordsSchema, knowledgeKeywordArticle } from './catalog.js';

const pnw = {
  schemaVersion: 1,
  catalogId: 'regional-pacific-northwest',
  sourceVersion: '2026.10.3',
  terms: ['Pacific Northwest', 'PNW'],
  articles: ['Bend, Oregon | Bend', 'Spokane, Washington | Spokane | The Lilac City'],
  matchCase: ['Bend'],
};

describe('KnowledgeCatalogKeywordsSchema', () => {
  it('reads a generated file and defaults what a hand-written one leaves out', () => {
    expect(KnowledgeCatalogKeywordsSchema.parse(pnw)).toEqual(pnw);
    expect(
      KnowledgeCatalogKeywordsSchema.parse({
        schemaVersion: 1,
        catalogId: 'caselaw-utah-part-0001',
        terms: ['Utah Supreme Court'],
      }),
    ).toEqual({
      schemaVersion: 1,
      catalogId: 'caselaw-utah-part-0001',
      terms: ['Utah Supreme Court'],
      articles: [],
      matchCase: [],
    });
  });

  it.each([
    ['an empty phrase', 'Spokane |  | Lilac City'],
    ['a padded phrase', ' Spokane | Lilac City'],
    ['a bare pipe', 'Spokane|Lilac City'],
    ['a doubled separator', 'Spokane || Lilac City'],
  ])('refuses an article line with %s', (_label, line) => {
    expect(KnowledgeCatalogKeywordsSchema.safeParse({ ...pnw, articles: [line] }).success).toBe(
      false,
    );
  });

  it('refuses a term that is not one trimmed phrase', () => {
    expect(
      KnowledgeCatalogKeywordsSchema.safeParse({ ...pnw, terms: ['PNW | Cascadia'] }).success,
    ).toBe(false);
    expect(KnowledgeCatalogKeywordsSchema.safeParse({ ...pnw, terms: ['PNW '] }).success).toBe(
      false,
    );
  });
});

describe('knowledgeKeywordArticle', () => {
  it('splits a line into its title and every phrase that names it', () => {
    expect(knowledgeKeywordArticle('Spokane, Washington | Spokane | The Lilac City')).toEqual({
      title: 'Spokane, Washington',
      phrases: ['Spokane, Washington', 'Spokane', 'The Lilac City'],
    });
    expect(knowledgeKeywordArticle('Angioplasty')).toEqual({
      title: 'Angioplasty',
      phrases: ['Angioplasty'],
    });
  });

  it('feeds the phrase matcher, which reports the article a phrase names', () => {
    const index = new PhraseIndex(
      pnw.articles.flatMap((line) => {
        const { title, phrases } = knowledgeKeywordArticle(line);
        return phrases.map((phrase) => ({ phrase, value: title }));
      }),
    );
    expect(index.longest('Any good hikes near spokane this weekend?')?.value).toBe(
      'Spokane, Washington',
    );
  });
});
