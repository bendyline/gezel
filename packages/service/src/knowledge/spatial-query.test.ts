import { spatialDocumentIdentity } from '@bendyline/gezel-inference/internal/knowledge/spatial-query';
import { describe, expect, it } from 'vitest';

describe('spatialDocumentIdentity', () => {
  it('collapses one article shipped in two regional catalogs', () => {
    expect(
      spatialDocumentIdentity('bendyline', 'regional-pacific-northwest', 'wikipedia-32706'),
    ).toBe(spatialDocumentIdentity('bendyline', 'regional-canada-alaska', 'wikipedia-32706'));
  });

  it('keeps other ids catalog-scoped and every id publisher-scoped', () => {
    expect(spatialDocumentIdentity('bendyline', 'notes-a', 'dovetails')).not.toBe(
      spatialDocumentIdentity('bendyline', 'notes-b', 'dovetails'),
    );
    expect(spatialDocumentIdentity('bendyline', 'regional-a', 'wikipedia-1')).not.toBe(
      spatialDocumentIdentity('someone-else', 'regional-a', 'wikipedia-1'),
    );
  });
});
