import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Task } from '@bendyline/gezel';
import {
  projectArtifactsDir,
  projectDiffpacksDir,
  projectDiffpacksFile,
  projectTaskFile,
  projectTaskNextIdFile,
} from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskManager } from '../tasks/manager.js';
import { Store } from './store.js';
import { TaskFilesStore, TaskWriteConflictError } from './task-files-store.js';

let home: string;
let store: TaskFilesStore;
const stamp = '2026-10-02T10:00:00.000Z';

function task(num = 1, projectId = 'alpha'): Task {
  return {
    projectId,
    num,
    ref: `${projectId}/${num}`,
    title: 'Existing work',
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

async function seed(raw: unknown, num = 1, projectId = 'alpha'): Promise<string> {
  const file = projectTaskFile(home, projectId, num);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(raw));
  return file;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-task-recovery-'));
  store = new TaskFilesStore({ home });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

describe('task identity recovery', () => {
  it.each([undefined, 'broken', '2oops', '-3', '1.5', '', '9007199254740992', '1'])(
    'recovers a missing, invalid or stale counter (%s)',
    async (counter) => {
      await store.createTask(task());
      // Orphaned records and outputs still reserve their identities.
      await seed({}, 9);
      await mkdir(join(projectArtifactsDir(home, 'alpha'), 'tasks', '12'), { recursive: true });
      await mkdir(join(projectDiffpacksDir(home, 'alpha'), '20'), { recursive: true });
      await writeFile(
        projectDiffpacksFile(home, 'alpha'),
        JSON.stringify({ version: 1, diffpacks: [{ packId: '22' }] }),
      );
      if (counter !== undefined) await writeFile(projectTaskNextIdFile(home, 'alpha'), counter);
      expect(await store.nextProjectTaskNum('alpha')).toBe(23);
      expect(await store.nextProjectTaskNum('alpha')).toBe(24);
      expect((await store.readTask('alpha', 1))?.title).toBe('Existing work');
    },
  );

  it('does not reset an unreadable counter and resumes after it is repaired', async () => {
    await store.createTask(task(7));
    const counter = projectTaskNextIdFile(home, 'alpha');
    await mkdir(counter);
    await expect(store.nextProjectTaskNum('alpha')).rejects.toThrow('Cannot read task counter');
    expect((await store.readTask('alpha', 7))?.title).toBe('Existing work');
    await rm(counter, { recursive: true });
    expect(await store.nextProjectTaskNum('alpha')).toBe(8);
  });

  it('stops if surviving proposal identities cannot be read', async () => {
    await store.createTask(task());
    await writeFile(projectDiffpacksFile(home, 'alpha'), '{broken');
    await expect(store.nextProjectTaskNum('alpha')).rejects.toThrow(
      'Cannot recover task identities',
    );
    await expect(readFile(projectTaskNextIdFile(home, 'alpha'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('shares allocation serialization across Store instances', async () => {
    const other = new TaskFilesStore({ home });
    const allocated = await Promise.all(
      Array.from({ length: 16 }, (_, i) => (i % 2 ? other : store).nextProjectTaskNum('alpha')),
    );
    expect([...allocated].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 16 }, (_, i) => i + 1),
    );
  });

  it('creates exclusively even when an existing task has no revision', async () => {
    const file = await seed(task());
    await writeFile(join(dirname(file), 'about.md'), 'original description');
    await expect(
      store.createTask({ ...task(), title: 'replacement', description: 'replacement' }),
    ).rejects.toBeInstanceOf(TaskWriteConflictError);
    expect(await store.readTask('alpha', 1)).toMatchObject({
      title: 'Existing work',
      description: 'original description',
    });
    const results = await Promise.allSettled([
      store.createTask(task(2)),
      store.createTask(task(2)),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
  });

  it('TaskManager cannot replace existing work even if an allocator returns its number', async () => {
    const product = new Store({ home });
    await product.ensureLayout();
    await product.createProject({ name: 'Alpha' });
    const manager = new TaskManager(product);
    const original = await manager.create('alpha', {
      title: 'Original',
      assignee: { kind: 'user' },
      steps: [{ name: 'Work' }],
    });
    vi.spyOn(product, 'nextProjectTaskNum').mockResolvedValue(original.num);
    await expect(
      manager.create('alpha', {
        title: 'Replacement',
        assignee: { kind: 'user' },
        steps: [{ name: 'Work' }],
      }),
    ).rejects.toBeInstanceOf(TaskWriteConflictError);
    expect((await product.readTask('alpha', original.num))?.title).toBe('Original');
  });
});

describe('damaged task isolation', () => {
  it.each([
    null,
    [],
    {},
    { ...task(), updatedAt: undefined },
    { ...task(), updatedAt: 42 },
    { ...task(), updatedAt: 'not-a-date' },
    { ...task(), craftbook: { steps: [] } },
    { ...task(), craftbook: undefined, phases: [null] },
    { ...task(), craftbook: undefined, phases: [{ id: 5 }] },
    { ...task(), craftbook: undefined, phases: 'broken' },
    { ...task(), ref: 'different/1' },
  ])('skips a malformed record while listing healthy projects (%j)', async (raw) => {
    const broken = await seed(raw);
    await store.createTask(task(1, 'healthy'));
    expect(await store.readTask('alpha', 1)).toBeNull();
    expect((await store.listAllTasks()).map((item) => item.ref)).toEqual(['healthy/1']);
    // Leave the damaged source intact for repair.
    expect(JSON.parse(await readFile(broken, 'utf8'))).toEqual(JSON.parse(JSON.stringify(raw)));
    await seed(task());
    expect((await store.listAllTasks()).map((item) => item.ref).sort()).toEqual([
      'alpha/1',
      'healthy/1',
    ]);
  });

  it('isolates syntactically broken JSON', async () => {
    const file = await seed(task());
    await writeFile(file, '{broken');
    expect(await store.listAllTasks()).toEqual([]);
    expect(await readFile(file, 'utf8')).toBe('{broken');
  });

  it('preserves harmless future fields through a read/edit/write cycle', async () => {
    const future = {
      ...task(),
      futureHint: { version: 2 },
      craftbook: {
        ...task().craftbook,
        steps: [{ ...task().craftbook.steps[0], futureStepHint: 'retained' }],
      },
    };
    const file = await seed(future);
    const current = (await store.readTask('alpha', 1))!;
    expect(current).toMatchObject(future);
    await store.writeTask({ ...current, title: 'Retitled' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      title: 'Retitled',
      futureHint: { version: 2 },
      craftbook: { steps: [{ futureStepHint: 'retained' }] },
    });
  });

  it('hydrates valid legacy phases and their missing timestamps', async () => {
    const {
      craftbook: _craftbook,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...legacy
    } = task();
    await seed({
      ...legacy,
      phases: [
        { id: 'first', name: 'First' },
        { id: 'last', name: 'Last' },
      ],
      activePhaseId: 'first',
    });
    expect(await store.readTask('alpha', 1)).toMatchObject({
      createdAt: '1970-01-01T00:00:00.000Z',
      updatedAt: '1970-01-01T00:00:00.000Z',
      activeStepId: 'first',
      craftbook: {
        entryStepId: 'first',
        steps: [
          { id: 'first', next: 'last' },
          { id: 'last', terminal: true },
        ],
      },
    });
  });
});
