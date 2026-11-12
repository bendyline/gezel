import type { RecentTab } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
const { nextKeptViews } = await import('./KeepAliveHost.js');
const { destinationFor } = await import('./destinations.js');

const tab = (fields: Record<string, unknown>) => ({ at: 0, order: 0, ...fields }) as RecentTab;

function visit(
  views: ReturnType<typeof nextKeptViews>,
  next: RecentTab | null,
  now: number,
  hiddenLimit = 3,
) {
  const target = destinationFor(next);
  return nextKeptViews(
    views,
    { key: target.key, tab: next, keepAlive: target.keepAlive },
    {
      hiddenLimit,
      now,
    },
  );
}

describe('kept views', () => {
  it('keeps Home and the newest hidden destinations, in first-visit order', () => {
    let views = visit([], null, 0);
    for (const [index, id] of ['a', 'b', 'c', 'd', 'e'].entries()) {
      views = visit(views, tab({ kind: 'project', id }), index + 1);
    }
    // e is shown; c and d (and b) are the newest hidden; a fell out; Home stays.
    expect(views.map((view) => view.key)).toEqual([
      'home',
      'project:b',
      'project:c',
      'project:d',
      'project:e',
    ]);
    expect(views.find((view) => view.key === 'project:e')?.hiddenAt).toBeNull();
  });

  it('keeps one hidden destination on a phone', () => {
    let views = visit([], tab({ kind: 'project', id: 'a' }), 0, 1);
    views = visit(views, tab({ kind: 'project', id: 'b' }), 1, 1);
    views = visit(views, tab({ kind: 'project', id: 'c' }), 2, 1);
    expect(views.map((view) => view.key)).toEqual(['project:b', 'project:c']);
  });

  it('drops Settings and editors as soon as they are left', () => {
    let views = visit([], tab({ kind: 'area', area: 'settings' }), 0);
    views = visit(views, tab({ kind: 'document', path: 'a.md' }), 1);
    views = visit(views, tab({ kind: 'area', area: 'tasks' }), 2);
    expect(views.map((view) => view.key)).toEqual(['area:tasks']);
  });

  it('drops a destination hidden for ten minutes, but never Home', () => {
    let views = visit([], null, 0);
    views = visit(views, tab({ kind: 'area', area: 'tasks' }), 1);
    views = visit(views, tab({ kind: 'project', id: 'a' }), 2);
    views = visit(views, tab({ kind: 'project', id: 'b' }), 11 * 60_000);
    expect(views.map((view) => view.key)).toEqual(['home', 'project:a', 'project:b']);
  });

  it('brings a kept view back without moving it', () => {
    let views = visit([], tab({ kind: 'project', id: 'a' }), 0);
    views = visit(views, tab({ kind: 'project', id: 'b' }), 1);
    views = visit(views, tab({ kind: 'project', id: 'a' }), 2);
    expect(views.map((view) => [view.key, view.hiddenAt])).toEqual([
      ['project:a', null],
      ['project:b', 2],
    ]);
  });
});
