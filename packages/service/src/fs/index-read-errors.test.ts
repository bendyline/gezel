import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChatSession, Task } from '@bendyline/gezel';
import { gezelSessionsDir, projectTaskFile, projectTasksDir } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from './store.js';
import { TaskFilesStore } from './task-files-store.js';

// 1.26300.100 audit: the in-memory task and session indexes treated any read
// error as "this file is gone". On Windows, antivirus, backup and synced
// folders answer EBUSY or EPERM for a moment, and on a daemon running without
// the app nothing listed the folder again until restart: an active task was
// never dispatched, a project looked empty, a task's thread was forgotten.

const { busy } = vi.hoisted(() => ({ busy: new Set<string>() }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const guard =
    <A extends unknown[], R>(fn: (path: never, ...rest: A) => Promise<R>) =>
    async (path: unknown, ...rest: A): Promise<R> => {
      if (typeof path === 'string' && busy.has(resolve(path))) {
        throw Object.assign(new Error(`EBUSY: resource busy or locked, '${path}'`), {
          code: 'EBUSY',
        });
      }
      return fn(path as never, ...rest);
    };
  const mocked = {
    ...actual,
    readFile: guard(actual.readFile as never),
    stat: guard(actual.stat as never),
    readdir: guard(actual.readdir as never),
  };
  return { ...mocked, default: mocked };
});

const stamp = '2026-10-27T10:00:00.000Z';
let home: string;

function task(num: number): Task {
  return {
    projectId: 'alpha',
    num,
    ref: `alpha/${num}`,
    title: 'Overnight work',
    status: 'active',
    assignee: { kind: 'user' },
    createdBy: { kind: 'user' },
    createdAt: stamp,
    updatedAt: stamp,
    craftbook: {
      id: 'fixture',
      name: 'Fixture',
      entryStepId: 'work',
      createdAt: stamp,
      updatedAt: stamp,
      steps: [{ id: 'work', name: 'Work', createdAt: stamp, terminal: true }],
    },
  };
}

async function activeNums(store: TaskFilesStore): Promise<number[]> {
  const nums: number[] = [];
  for await (const t of store.iterateProjectTasksWithStatus('alpha', 'active')) nums.push(t.num);
  return nums;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-index-read-errors-'));
});

afterEach(async () => {
  busy.clear();
  await rm(home, { recursive: true, force: true });
});

describe('task indexes and read errors', () => {
  it('keeps a task it briefly could not read', async () => {
    const store = new TaskFilesStore({ home });
    await store.createTask(task(1));
    expect(await activeNums(store)).toEqual([1]);

    busy.add(resolve(projectTaskFile(home, 'alpha', 1)));
    expect(await activeNums(store)).toEqual([]);
    busy.clear();
    expect(await activeNums(store)).toEqual([1]);
  });

  it('lists a project again when its task folder could not be read', async () => {
    await new TaskFilesStore({ home }).createTask(task(1));
    const store = new TaskFilesStore({ home });

    busy.add(resolve(projectTasksDir(home, 'alpha')));
    expect(await activeNums(store)).toEqual([]);
    busy.clear();
    expect(await activeNums(store)).toEqual([1]);
  });
});

describe('task-session index and read errors', () => {
  const session = (id: string): ChatSession => ({
    version: 1,
    id,
    gezelId: 'ada',
    projectId: 'default',
    providerName: 'copilot',
    model: 'mock-fast',
    title: 'Untitled',
    createdAt: stamp,
    lastActivityAt: stamp,
    messages: [],
    providerState: {},
    taskRef: 'default/7',
  });

  it("keeps a task's thread it briefly could not read", async () => {
    const store = new Store({ home });
    await store.ensureLayout();
    await store.createGezel({ name: 'Ada', role: 'Developer' });
    await store.writeSession(session('s1'));
    expect((await store.listTaskSessions('default/7')).map((s) => s.id)).toEqual(['s1']);

    busy.add(resolve(store.sessionRecordPath('ada', 's1')));
    expect(await store.listTaskSessions('default/7')).toEqual([]);
    busy.clear();
    expect((await store.listTaskSessions('default/7')).map((s) => s.id)).toEqual(['s1']);
  });

  it('lists a gezel again when its session folder could not be read', async () => {
    const seeded = new Store({ home });
    await seeded.ensureLayout();
    await seeded.createGezel({ name: 'Ada', role: 'Developer' });
    await seeded.writeSession(session('s1'));
    const store = new Store({ home });

    busy.add(resolve(gezelSessionsDir(home, 'ada')));
    expect(await store.listTaskSessions('default/7', { gezelId: 'ada' })).toEqual([]);
    busy.clear();
    expect(
      (await store.listTaskSessions('default/7', { gezelId: 'ada' })).map((s) => s.id),
    ).toEqual(['s1']);
  });
});
