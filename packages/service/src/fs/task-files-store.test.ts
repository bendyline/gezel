import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gezelPaths, projectTaskFile, projectTaskNextIdFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    // A directory squatting on the counter path makes the atomic write's
    // rename fail, standing in for ENOSPC/EPERM-class disk failures.
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
});

describe('TaskFilesStore.listAllTasks', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-task-list-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('ignores Finder metadata instead of aborting the scheduler-wide scan', async () => {
    const taskFile = projectTaskFile(home, 'alpha', 1);
    await mkdir(dirname(taskFile), { recursive: true });
    await writeFile(
      taskFile,
      `${JSON.stringify({
        projectId: 'alpha',
        num: 1,
        ref: 'alpha/1',
        createdAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
      })}\n`,
    );
    await writeFile(join(gezelPaths(home).projects, '.DS_Store'), 'finder metadata');

    const tasks = await new TaskFilesStore({ home }).listAllTasks();
    expect(tasks.map((task) => task.ref)).toEqual(['alpha/1']);
  });
});
