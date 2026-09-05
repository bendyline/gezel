import { describe, expect, it } from 'vitest';
import { CatalogDocumentSchema, KnowledgeOrdinalSchema } from './document.js';

const base = {
  id: 'conceptual/welcome',
  title: 'Welcome',
  slug: 'welcome',
  language: 'en',
  topicPath: ['conceptual'],
  markdown: '# Welcome\n',
};

describe('CatalogDocumentSchema', () => {
  it('accepts a document without the 0.6 fields', () => {
    expect(CatalogDocumentSchema.safeParse(base).success).toBe(true);
  });

  it('accepts an ordinal, negative or not, and an opaque meta object', () => {
    const parsed = CatalogDocumentSchema.parse({
      ...base,
      ordinal: -26234,
      meta: { area: 'whats-new', tags: ['release'], nested: { order: 1 } },
    });
    expect(parsed.ordinal).toBe(-26234);
    expect(parsed.meta).toEqual({ area: 'whats-new', tags: ['release'], nested: { order: 1 } });
  });

  it('bounds the ordinal to an int32 and requires a topic path', () => {
    expect(KnowledgeOrdinalSchema.safeParse(2_147_483_647).success).toBe(true);
    expect(KnowledgeOrdinalSchema.safeParse(2_147_483_648).success).toBe(false);
    expect(KnowledgeOrdinalSchema.safeParse(1.5).success).toBe(false);
    expect(CatalogDocumentSchema.safeParse({ ...base, topicPath: [] }).success).toBe(false);
    expect(CatalogDocumentSchema.safeParse({ ...base, meta: 'x' }).success).toBe(false);
  });
});
