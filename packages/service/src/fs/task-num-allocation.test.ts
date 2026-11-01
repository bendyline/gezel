/**
 * Task number allocation lists the task folders once per store, not once per
 * task: in a 145k-task project every listing took seconds under the project
 * lock, which capped task creation near 22 a minute (2026-10-27). These tests
 * pin the cost and the identity guarantees that the listing protected —
 * folders reserved outside the allocator are still never reissued.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  projectArtifactsDir,
  projectDiffpacksDir,
  projectTaskFile,
  projectTasksDir,
} from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskFilesStore } from './task-files-store.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-task-num-'));
});
afterEach(async () => {
  vi.mocked(fsp.readdir).mockClear();
  await rm(home, { recursive: true, force: true });
});

const taskFolder = (num: number) =>
  mkdir(dirname(projectTaskFile(home, 'alpha', num)), { recursive: true });
const listingsOf = (dir: string) =>
  vi.mocked(fsp.readdir).mock.calls.filter(([path]) => String(path) === dir).length;

describe('task number allocation', () => {
  it('lists the task folders once, then allocates from the counter', async () => {
    await taskFolder(4);
    const store = new TaskFilesStore({ home });
    const issued: number[] = [];
    for (let i = 0; i < 20; i++) issued.push(await store.nextProjectTaskNum('alpha'));
    expect(issued).toEqual(Array.from({ length: 20 }, (_, i) => i + 5));
    expect(listingsOf(projectTasksDir(home, 'alpha'))).toBe(1);
  });

  it('rescans past folders created outside the allocator when their number comes up', async () => {
    const store = new TaskFilesStore({ home });
    expect(await store.nextProjectTaskNum('alpha')).toBe(1);
    // An orphaned record, a gezel's drawer folder and a proposal folder.
    await taskFolder(2);
    await mkdir(join(projectArtifactsDir(home, 'alpha'), 'tasks', '6'), { recursive: true });
    await mkdir(join(projectDiffpacksDir(home, 'alpha'), '9'), { recursive: true });
    expect(await store.nextProjectTaskNum('alpha')).toBe(10);
    expect(await store.nextProjectTaskNum('alpha')).toBe(11);
  });

  it('honours a reservation above the next number once allocation reaches it', async () => {
    const store = new TaskFilesStore({ home });
    expect(await store.nextProjectTaskNum('alpha')).toBe(1);
    await mkdir(join(projectArtifactsDir(home, 'alpha'), 'tasks', '3'), { recursive: true });
    expect(await store.nextProjectTaskNum('alpha')).toBe(2);
    expect(await store.nextProjectTaskNum('alpha')).toBe(4);
  });

  it('follows numbers another store issued for the same project', async () => {
    const first = new TaskFilesStore({ home });
    const second = new TaskFilesStore({ home });
    expect(await first.nextProjectTaskNum('alpha')).toBe(1);
    expect(await second.nextProjectTaskNum('alpha')).toBe(2);
    expect(await second.nextProjectTaskNum('alpha')).toBe(3);
    expect(await first.nextProjectTaskNum('alpha')).toBe(4);
    const allocated = await Promise.all(
      Array.from({ length: 12 }, (_, i) => (i % 2 ? first : second).nextProjectTaskNum('alpha')),
    );
    expect([...allocated].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 5),
    );
  });
});
