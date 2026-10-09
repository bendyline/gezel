import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { InvalidTaskWriteError } from '../fs/task-files-store.js';
import { HistoryManager } from '../history/manager.js';
import { TaskManager } from './manager.js';

let home: string;
let store: Store;
let tasks: TaskManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-invalid-task-'));
  const history = new HistoryManager(home);
  store = new Store({ home, history });
  await store.ensureLayout();
  await store.ensureDefaultProject();
  tasks = new TaskManager(store, history);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// A step whose tool policy removed a protected tool was created, then skipped
// as unreadable on every read: the task silently disappeared (2026-10-08).
describe('a task the reader would refuse', () => {
  it('is refused on create, with the reason, and leaves no file behind', async () => {
    const create = tasks.create('default', {
      title: 'Nightly review',
      assignee: { kind: 'user' },
      steps: [
        {
          id: 'review',
          name: 'Review',
          prompt: 'Review the projects.',
          toolPolicy: { disallowTools: ['ask_user_question'] },
        },
      ],
      entryStepId: 'review',
    });

    await expect(create).rejects.toBeInstanceOf(InvalidTaskWriteError);
    await expect(create).rejects.toThrow(/ask_user_question is a workflow safety tool/);
    expect(await store.listProjectTasks('default')).toEqual([]);
    const tasksDir = join(home, 'projects', 'default', 'tasks');
    const left = await readdir(tasksDir).catch(() => []);
    for (const entry of left) {
      expect(await readdir(join(tasksDir, entry)).catch(() => [])).not.toContain('task.json');
    }
  });

  it('is refused on update, and the saved task stays as it was', async () => {
    const created = await tasks.create('default', {
      title: 'Nightly review',
      assignee: { kind: 'user' },
      steps: [{ id: 'review', name: 'Review', prompt: 'Review the projects.' }],
      entryStepId: 'review',
    });
    const saved = (await store.readTask('default', created.num))!;

    await expect(
      store.writeTask({
        ...saved,
        craftbook: {
          ...saved.craftbook,
          steps: saved.craftbook.steps.map((s) => ({
            ...s,
            toolPolicy: { disallowTools: ['ask_user_question'] },
          })),
        },
      }),
    ).rejects.toBeInstanceOf(InvalidTaskWriteError);

    const after = await store.readTask('default', created.num);
    expect(after?.craftbook.steps[0]?.toolPolicy).toBeUndefined();
    expect(after?.revision).toBe(saved.revision);
  });
});
