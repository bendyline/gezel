import { OFFLINE_RUNTIME_CAPABILITIES, type RecentTab } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
const { destinationFor, prepareDestination, readsAreKnown } = await import('./destinations.js');
const { api } = await import('../api.js');
const { setRead } = await import('../data/api-reads.js');

/** A recent-tab entry, without the ordering fields the registry ignores. */
const tab = (fields: Record<string, unknown>) => ({ at: 0, order: 0, ...fields }) as RecentTab;

describe('destination registry', () => {
  it('gives each tab its own identity and a project its project reads', () => {
    const project = destinationFor(tab({ kind: 'project', id: 'p1' }));
    expect(project.key).toBe('project:p1');
    expect(project.frame).toBe('project');
    expect(project.reads).toContainEqual(['getProject', 'p1']);
    expect(destinationFor(tab({ kind: 'project', id: 'p2' })).key).not.toBe(project.key);
    expect(destinationFor(null).key).toBe('home');
  });

  it('warms the daemon home read only on a host that has one', () => {
    const homeRead = ['getSystemHomeInfo'];
    expect(destinationFor(null).reads).toContainEqual(homeRead);
    const host = window as { __GEZEL__?: unknown };
    host.__GEZEL__ = { capabilities: OFFLINE_RUNTIME_CAPABILITIES };
    try {
      expect(destinationFor(null).reads).not.toContainEqual(homeRead);
      expect(destinationFor(null).reads).toContainEqual(['listProjects']);
    } finally {
      host.__GEZEL__ = undefined;
    }
  });

  it('never keeps editors or Settings alive', () => {
    expect(destinationFor(tab({ kind: 'area', area: 'settings' })).keepAlive).toBe(false);
    expect(destinationFor(tab({ kind: 'document', path: 'a.md' })).keepAlive).toBe(false);
    expect(destinationFor(tab({ kind: 'area', area: 'tasks' })).keepAlive).toBe(true);
    expect(destinationFor(null).keepAlive).toBe(true);
  });

  it('knows when every read a destination paints from is in memory', async () => {
    const tasks = destinationFor(tab({ kind: 'area', area: 'tasks' }));
    expect(readsAreKnown(tasks)).toBe(false);
    setRead('getConfig', [], { provider: 'mock' } as never);
    setRead('listGezels', [], { gezels: [] } as never);
    expect(readsAreKnown(tasks)).toBe(true);
  });

  it('starts code and reads together, and settles even when a read fails', async () => {
    vi.mocked(api.getProject).mockRejectedValueOnce(new Error('gone'));
    const target = destinationFor(tab({ kind: 'project', id: 'p1' }));
    const load = vi.fn(async () => ({}));
    await expect(prepareDestination({ ...target, load })).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledOnce();
    expect(api.getProject).toHaveBeenCalledWith('p1');
  });
});
