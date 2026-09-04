import { describe, expect, it } from 'vitest';
import { formatKnowledgeUri, parseKnowledgeUri } from './uri.js';

describe('knowledge:// references', () => {
  it('round-trips a publisher-qualified document with a nested id and a chunk fragment', () => {
    const uri = formatKnowledgeUri({
      publisherId: 'bendyline',
      catalogId: 'wikipedia-physics',
      documentId: 'Mechanics/Newton laws',
      fragment: { chunk: 'a'.repeat(32) },
    });
    expect(uri).toBe(
      `knowledge://bendyline/wikipedia-physics/Mechanics/Newton%20laws#chunk=${'a'.repeat(32)}`,
    );
    expect(parseKnowledgeUri(uri)).toEqual({
      publisherId: 'bendyline',
      catalogId: 'wikipedia-physics',
      documentId: 'Mechanics/Newton laws',
      fragment: { chunk: 'a'.repeat(32) },
    });
  });

  it('parses line fragments with and without an end line', () => {
    expect(parseKnowledgeUri('knowledge://me/notes/readme#line=12')?.fragment).toEqual({
      lineStart: 12,
    });
    expect(parseKnowledgeUri('knowledge://me/notes/readme#line=12-40')?.fragment).toEqual({
      lineStart: 12,
      lineEnd: 40,
    });
  });

  it.each([
    'https://example.test/x',
    'knowledge://',
    'knowledge://notes/doc',
    'knowledge://Bad_Publisher/notes/doc',
    'knowledge://me/Bad_Catalog/doc',
    'knowledge://me/notes/',
    'knowledge://me//doc',
    'knowledge://me/notes//doc',
    'knowledge://me/notes/doc#chunk=nope',
    'knowledge://me/notes/doc#page=3',
    `knowledge://me/notes/${'a'.repeat(513)}`,
  ])('rejects %s', (raw) => {
    expect(parseKnowledgeUri(raw)).toBeNull();
  });
});
