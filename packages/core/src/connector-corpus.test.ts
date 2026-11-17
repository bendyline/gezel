import { describe, expect, it } from 'vitest';
import { isConnectorCorpusPath } from './connector-corpus.js';

describe('isConnectorCorpusPath', () => {
  it('marks connector records under data/, not their mutable surface', () => {
    expect(isConnectorCorpusPath('data/site/site-test/001--home--abcd1234.md')).toBe(true);
    expect(isConnectorCorpusPath('artifacts/data/site/x.md')).toBe(true);
    expect(isConnectorCorpusPath(['data', 'site', 'x.md'].join('\\'))).toBe(true);
    expect(isConnectorCorpusPath('data/site/_actions/_drafts/a.md')).toBe(false);
    expect(isConnectorCorpusPath('reports/2026-11-16.md')).toBe(false);
    expect(isConnectorCorpusPath('data')).toBe(false);
    expect(isConnectorCorpusPath('notes/../data/site/x.md')).toBe(true);
  });
});
