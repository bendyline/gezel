import { describe, expect, it } from 'vitest';
import { isConnectorBookkeepingPath, isConnectorCorpusPath } from './connector-corpus.js';

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

describe('isConnectorBookkeepingPath', () => {
  it('marks the engine files anywhere inside a corpus', () => {
    expect(isConnectorBookkeepingPath('data/github-pull-requests/_meta.json')).toBe(true);
    expect(isConnectorBookkeepingPath('data/github-pull-requests/pr-58/_flags.json')).toBe(true);
    expect(isConnectorBookkeepingPath('artifacts/data/mail/inbox/_listing.json')).toBe(true);
    expect(isConnectorBookkeepingPath('Data/mail/_FLAGS.json')).toBe(true);
    expect(isConnectorBookkeepingPath(['data', 'mail', '_meta.json'].join('\\'))).toBe(true);
  });

  it('leaves records, person-facing underscore folders, and other drawers alone', () => {
    expect(isConnectorBookkeepingPath('data/github-pull-requests/pr-58/001--overview.md')).toBe(
      false,
    );
    expect(isConnectorBookkeepingPath('data/mail/_outbox/draft.json')).toBe(false);
    expect(isConnectorBookkeepingPath('data/mail/_drafts')).toBe(false);
    expect(isConnectorBookkeepingPath('data/_meta.json')).toBe(false);
    expect(isConnectorBookkeepingPath('reports/_meta.json')).toBe(false);
    expect(isConnectorBookkeepingPath('data/github-pull-requests')).toBe(false);
  });
});
