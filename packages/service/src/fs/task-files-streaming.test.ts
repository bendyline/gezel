/** Existence checks should read a bounded prefix without retaining task history. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@bendyline/gezel';
import { expect, it, vi } from 'vitest';
import { TaskFilesStore } from './task-files-store.js';

it('streams newest tasks first and stops reading when the consumer has its answer', async () => {
  const home = await mkdtemp(join(tmpdir(), 'task-stream-'));
  try {
    for (const name of ['1', '2', '10', 'junk']) await mkdir(join(home, 'projects/p/tasks', name), { recursive: true });
    const store = new TaskFilesStore({ home });
    const read = vi.spyOn(store, 'readTask').mockImplementation(async (projectId, num) => ({ projectId, num } as Task));
    for await (const task of store.iterateProjectTasks('p')) {
      expect(task.num).toBe(10);
      break;
    }
    expect(read.mock.calls).toEqual([['p', 10]]);
    expect((await store.listProjectTasks('p')).map((task) => task.num)).toEqual([10, 2, 1]);
  } finally { await rm(home, { recursive: true, force: true }); }
});
