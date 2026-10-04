/** Regression coverage for bounded task reads and inherited lifecycle decisions. */
import { type Task, withEffectiveTaskStatuses } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import { readTaskWithEffectiveStatus } from './effective-status.js';

const task = (num: number, status: Task['status'] = 'active', parentTaskRef?: string): Task =>
  ({ projectId: 'p', num, ref: `p/${num}`, status, parentTaskRef } as Task);

function reader(tasks: Task[]) {
  const byRef = new Map(tasks.map((item) => [item.ref, item]));
  return { readTask: vi.fn(async (project: string, num: number) => byRef.get(`${project}/${num}`) ?? null) };
}

describe('readTaskWithEffectiveStatus', () => {
  it('reads only the child and its ancestors in a large task collection', async () => {
    const child = task(3, 'active', 'p/2');
    const store = reader([task(1, 'paused'), task(2, 'active', 'p/1'), child,
      ...Array.from({ length: 10_000 }, (_, i) => task(i + 4, 'complete'))]);
    expect((await readTaskWithEffectiveStatus(store, 'p', 3))?.effectiveStatus).toBe('paused');
    expect(store.readTask.mock.calls).toEqual([['p', 3], ['p', 2], ['p', 1]]);
    expect(child.effectiveStatus).toBeUndefined();
  });

  it('observes parent resumes and terminal transitions on the next read', async () => {
    const parent = task(1, 'paused'), child = task(2, 'active', 'p/1');
    const store = reader([parent, child]);
    for (const status of ['paused', 'active', 'complete', 'canceled', 'draft'] as const) {
      parent.status = status;
      expect((await readTaskWithEffectiveStatus(store, 'p', 2))?.effectiveStatus)
        .toBe(status === 'draft' ? 'active' : status);
    }
  });

  it('preserves the core projection for missing parents and cyclic ancestry', async () => {
    for (const rows of [[task(1, 'active', 'p/99')],
      [task(1, 'active', 'p/2'), task(2, 'paused', 'p/1')],
      [task(1, 'paused', 'p/2'), task(2, 'active', 'p/3'), task(3, 'canceled')]]) {
      const store = reader(rows);
      expect(await readTaskWithEffectiveStatus(store, 'p', 1)).toEqual(withEffectiveTaskStatuses(rows)[0]);
      expect(store.readTask.mock.calls.length).toBeLessThanOrEqual(rows.length + 1);
    }
    expect(await readTaskWithEffectiveStatus(reader([]), 'p', 1)).toBeNull();
  });

  it('reads cross-project ancestors and propagates storage failures', async () => {
    const rows = [task(1, 'active', 'other/2'), { ...task(2, 'canceled'), ref: 'other/2', projectId: 'other' }];
    expect((await readTaskWithEffectiveStatus(reader(rows), 'p', 1))?.effectiveStatus).toBe('canceled');
    const store = { readTask: vi.fn(async () => { throw new Error('unavailable'); }) };
    await expect(readTaskWithEffectiveStatus(store, 'p', 1)).rejects.toThrow('unavailable');
  });
});
