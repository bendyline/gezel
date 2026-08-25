import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectTaskNextIdFile } from '@bendyline/gezel/paths';
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
