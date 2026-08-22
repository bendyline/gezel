import type { UnifiedSearchResult } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { flattenGroups, groupResults, resultToActions } from './search-nav.js';

function result(
  partial: Partial<UnifiedSearchResult> & { kind: UnifiedSearchResult['kind'] },
): UnifiedSearchResult {
  return { id: 'x', title: 't', score: 1, ...partial };
}

describe('resultToActions', () => {
  it('maps a project result to an open-tab event', () => {
    const actions = resultToActions(result({ kind: 'project', id: 'project:p1', projectId: 'p1' }));
    expect(actions).toEqual([
      { kind: 'event', type: 'gezel:open-tab', detail: { kind: 'project', id: 'p1' } },
    ]);
  });

  it('maps a gezel result, recovering the id from the kind-scoped id', () => {
    const actions = resultToActions(result({ kind: 'gezel', id: 'gezel:g1' }));
    expect(actions).toEqual([
      { kind: 'event', type: 'gezel:open-tab', detail: { kind: 'gezel', id: 'g1' } },
    ]);
  });

  it('maps a document result to an open-tab document event', () => {
    const actions = resultToActions(
      result({ kind: 'document', id: 'document:jobs/cv.md', path: 'jobs/cv.md' }),
    );
    expect(actions).toEqual([
      { kind: 'event', type: 'gezel:open-tab', detail: { kind: 'document', path: 'jobs/cv.md' } },
    ]);
  });

  it('maps a file result to: queue intent, open project, then open-file', () => {
    const actions = resultToActions(
      result({
        kind: 'file',
        id: 'file:p1:src/index.html',
        projectId: 'p1',
        path: 'src/index.html',
        source: 'workspace',
      }),
    );
    expect(actions[0]).toEqual({
      kind: 'open-file',
      intent: { projectId: 'p1', path: 'src/index.html', source: 'workspace' },
    });
    expect(actions[1]).toEqual({
      kind: 'event',
      type: 'gezel:open-tab',
      detail: { kind: 'project', id: 'p1' },
    });
    expect(actions[2]).toEqual({
      kind: 'event',
      type: 'gezel:open-file',
      detail: { projectId: 'p1', path: 'src/index.html', source: 'workspace' },
    });
  });

  it('maps a session result to: queue intent, open gezel, then open-session', () => {
    const actions = resultToActions(
      result({ kind: 'session', id: 'session:sess-1', gezelId: 'ada', projectId: 'p1' }),
    );
    const intent = { gezelId: 'ada', sessionId: 'sess-1', projectId: 'p1' };
    expect(actions).toEqual([
      { kind: 'open-session', intent },
      { kind: 'event', type: 'gezel:open-tab', detail: { kind: 'gezel', id: 'ada' } },
      { kind: 'event', type: 'gezel:open-session', detail: intent },
    ]);
  });

  it('drops a session result without a gezelId', () => {
    expect(resultToActions(result({ kind: 'session', id: 'session:sess-1' }))).toEqual([]);
  });

  it('routes a content hit like a file (open project + focus file)', () => {
    const actions = resultToActions(
      result({
        kind: 'content',
        id: 'content:p1:src/game.js:10',
        projectId: 'p1',
        path: 'src/game.js',
        source: 'workspace',
        line: 10,
      }),
    );
    expect(actions.map((a) => ('type' in a ? a.type : a.kind))).toEqual([
      'open-file',
      'gezel:open-tab',
      'gezel:open-file',
    ]);
  });

  it('maps a knowledge result to: queue intent, open area, then live event', () => {
    const actions = resultToActions(
      result({
        kind: 'knowledge',
        id: 'knowledge:shop-notes:abc123',
        catalogId: 'shop-notes',
        documentId: 'dovetails',
        uri: 'knowledge://shop-notes/dovetails#chunk=abc123',
      }),
    );
    const intent = { catalogId: 'shop-notes', documentId: 'dovetails' };
    expect(actions).toEqual([
      { kind: 'open-knowledge', intent },
      { kind: 'event', type: 'gezel:open-tab', detail: { kind: 'area', area: 'knowledge' } },
      { kind: 'event', type: 'gezel:open-knowledge-document', detail: intent },
    ]);
  });

  it('drops a knowledge result without a catalogId', () => {
    expect(resultToActions(result({ kind: 'knowledge', id: 'knowledge:x' }))).toEqual([]);
  });
});

describe('groupResults / flattenGroups', () => {
  it('leads with the best-scoring group, not a fixed kind order', () => {
    // The regression: a library document that out-ranked every file landed
    // below all of them because `file` was listed above `document`.
    const groups = groupResults([
      result({ kind: 'document', id: 'd1', score: 680 }),
      result({ kind: 'file', id: 'f1', score: 548 }),
      result({ kind: 'file', id: 'f2', score: 285 }),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(['document', 'file']);
    expect(flattenGroups(groups).map((r) => r.id)).toEqual(['d1', 'f1', 'f2']);
  });

  it('caps a group and reports what it held back', () => {
    const files = Array.from({ length: 8 }, (_, i) =>
      result({ kind: 'file', id: `f${i}`, score: 285 }),
    );
    const groups = groupResults([...files, result({ kind: 'document', id: 'd1', score: 680 })], {
      perGroupLimit: 5,
    });
    const fileGroup = groups.find((g) => g.kind === 'file');
    expect(fileGroup?.items).toHaveLength(5);
    expect(fileGroup?.moreCount).toBe(3);
    expect(groups.find((g) => g.kind === 'document')?.moreCount).toBeUndefined();
    // Keyboard nav indexes the capped list, so it must agree with the render.
    expect(flattenGroups(groups)).toHaveLength(6);
  });

  it('buckets into fixed order and the flat list matches visual order', () => {
    const results: UnifiedSearchResult[] = [
      result({ kind: 'content', id: 'c1', title: 'c' }),
      result({ kind: 'project', id: 'p1', title: 'p', projectId: 'p1' }),
      result({ kind: 'file', id: 'f1', title: 'f' }),
    ];
    // Equal scores — the fixed order is the tie-break, not the ranking.
    const groups = groupResults(results);
    expect(groups.map((g) => g.kind)).toEqual(['project', 'file', 'content']);
    expect(flattenGroups(groups).map((r) => r.id)).toEqual(['p1', 'f1', 'c1']);
  });

  it('omits empty groups', () => {
    expect(groupResults([])).toEqual([]);
  });
});
