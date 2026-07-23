import { describe, expect, it } from 'vitest';
import { type RecentTabInput, tabKey, toRecentTab } from './recent-tabs.js';

describe('tabKey', () => {
  it('derives a stable key per kind', () => {
    expect(tabKey({ kind: 'project', id: 'p1' })).toBe('project:p1');
    expect(tabKey({ kind: 'gezel', id: 'g1' })).toBe('gezel:g1');
    expect(tabKey({ kind: 'document', path: 'guidelines/a.md' })).toBe('document:guidelines/a.md');
    expect(tabKey({ kind: 'task', ref: 'proj/task-1' })).toBe('task:proj/task-1');
    expect(tabKey({ kind: 'area', area: 'settings' })).toBe('area:settings');
  });

  it('round-trips a built RecentTab to the same key as its input', () => {
    const inputs: RecentTabInput[] = [
      { kind: 'project', id: 'p1' },
      { kind: 'gezel', id: 'g1' },
      { kind: 'document', path: 'a/b.md' },
      { kind: 'task', ref: 'r/1' },
      { kind: 'area', area: 'tasks' },
    ];
    for (const input of inputs) {
      expect(tabKey(toRecentTab(input))).toBe(tabKey(input));
    }
  });
});

describe('toRecentTab', () => {
  it('builds a discriminated RecentTab carrying the input payload', () => {
    expect(toRecentTab({ kind: 'project', id: 'p1' })).toMatchObject({
      kind: 'project',
      id: 'p1',
    });
    expect(toRecentTab({ kind: 'document', path: 'a.md' })).toMatchObject({
      kind: 'document',
      path: 'a.md',
    });
    expect(toRecentTab({ kind: 'area', area: 'history' })).toMatchObject({
      kind: 'area',
      area: 'history',
    });
  });

  it('stamps the vestigial at/order fields so the schema type is satisfied', () => {
    const tab = toRecentTab({ kind: 'gezel', id: 'g1' });
    expect(typeof tab.at).toBe('number');
    expect(typeof tab.order).toBe('number');
  });
});
