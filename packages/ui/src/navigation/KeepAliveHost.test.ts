import type { RecentTab } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
const { arrangeFor, nextKeptViews, withShownView } = await import('./KeepAliveHost.js');
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

  it('arranges the shown key and the views together, and drops a crashed view once left', () => {
    const options = { hiddenLimit: 3, now: 1 };
    const project = (id: string) => {
      const next = tab({ kind: 'project', id });
      return { key: destinationFor(next).key, tab: next, keepAlive: true };
    };
    let state = arrangeFor({ shownKey: '', views: [], crashed: new Set() }, project('a'), options);
    state = arrangeFor(state, project('b'), options);
    expect(state.shownKey).toBe('project:b');
    expect(state.views.find((view) => view.hiddenAt === null)?.key).toBe('project:b');

    // b crashed while shown: it stays until left, then unmounts.
    state = { ...state, crashed: new Set(['project:b']) };
    state = arrangeFor(state, project('c'), options);
    expect(state.views.map((view) => view.key)).toEqual(['project:a', 'project:c']);
    expect(state.crashed.size).toBe(0);
  });

  it('always renders the shown destination, even when the kept set lacks it', () => {
    const shown = { key: 'project:b', tab: tab({ kind: 'project', id: 'b' }) };
    const views = visit([], tab({ kind: 'project', id: 'a' }), 0);
    expect(withShownView(views, shown).map((view) => [view.key, view.hiddenAt])).toEqual([
      ['project:a', null],
      ['project:b', null],
    ]);
    const complete = visit(views, shown.tab, 1);
    expect(withShownView(complete, shown)).toBe(complete);
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
