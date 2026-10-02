import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gezelPaths, projectTaskFile, projectTaskNextIdFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as atomic from './atomic.js';
import { TaskFilesStore } from './task-files-store.js';

describe('TaskFilesStore.nextProjectTaskNum', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-tasknum-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('a failed allocation rejects its caller without poisoning later ones', async () => {
    const store = new TaskFilesStore({ home });
    const counter = projectTaskNextIdFile(home, 'alpha');
    // An unreadable counter must fail closed, then recover after repair.
    await mkdir(counter, { recursive: true });
    await expect(store.nextProjectTaskNum('alpha')).rejects.toThrow();

    await rm(counter, { recursive: true, force: true });
    await expect(store.nextProjectTaskNum('alpha')).resolves.toBe(1);
    await expect(store.nextProjectTaskNum('alpha')).resolves.toBe(2);
  });

  it('a failure in one project leaves other projects unaffected', async () => {
    const store = new TaskFilesStore({ home });
    await mkdir(projectTaskNextIdFile(home, 'alpha'), { recursive: true });
    await expect(store.nextProjectTaskNum('alpha')).rejects.toThrow();
    await expect(store.nextProjectTaskNum('beta')).resolves.toBe(1);
  });

  it('releases a failed counter publication without reusing an issued number', async () => {
    const store = new TaskFilesStore({ home });
    expect(await store.nextProjectTaskNum('alpha')).toBe(1);
    const spy = vi
      .spyOn(atomic, 'writeFileAtomic')
      .mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    try {
      const results = await Promise.allSettled([
        store.nextProjectTaskNum('alpha'),
        new TaskFilesStore({ home }).nextProjectTaskNum('alpha'),
      ]);
      expect(results).toMatchObject([
        { status: 'rejected', reason: { code: 'ENOSPC' } },
        { status: 'fulfilled', value: 2 },
      ]);
    } finally {
      spy.mockRestore();
    }
    expect(await new TaskFilesStore({ home }).nextProjectTaskNum('alpha')).toBe(3);
  });
});

describe('TaskFilesStore.listAllTasks', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-task-list-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('ignores centralized OS/sync junk and unsafe dot folders during scheduler scans', async () => {
    const writeTask = async (projectId: string, num: number): Promise<void> => {
      const taskFile = projectTaskFile(home, projectId, num);
      await mkdir(dirname(taskFile), { recursive: true });
      await writeFile(
        taskFile,
        `${JSON.stringify({
          projectId,
          num,
          ref: `${projectId}/${num}`,
          title: 'Scheduler fixture',
          status: 'active',
          assignee: { kind: 'user' },
          createdBy: { kind: 'user' },
          craftbook: {
            id: 'fixture',
            name: 'Fixture',
            entryStepId: 'work',
            steps: [{ id: 'work', name: 'Work', createdAt: '2026-08-25T00:00:00.000Z' }],
            createdAt: '2026-08-25T00:00:00.000Z',
            updatedAt: '2026-08-25T00:00:00.000Z',
          },
          createdAt: '2026-08-25T00:00:00.000Z',
          updatedAt: '2026-08-25T00:00:00.000Z',
        })}\n`,
      );
    };

    await writeTask('alpha', 1);
    // These names are valid entity ids, so this proves the shared junk
    // predicate excludes them rather than relying only on id validation.
    await writeTask('Thumbs.db', 98);
    await writeTask('desktop.ini', 99);
    await writeTask('unfinished.partial', 100);
    await writeFile(join(gezelPaths(home).projects, '.DS_Store'), 'finder metadata');
    await mkdir(join(gezelPaths(home).projects, '.git'), { recursive: true });

    const tasks = await new TaskFilesStore({ home }).listAllTasks();
    expect(tasks.map((task) => task.ref)).toEqual(['alpha/1']);
  });
});
