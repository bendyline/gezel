import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import type { TaskManager } from '../tasks/manager.js';
import {
  reopenIssuesForDismissedPack,
  resolveIssuesForAppliedFiles,
  settleIssuesForDraftingTask,
} from './issue-lifecycle.js';
import { DiffpackManager } from './manager.js';

let home: string;
let store: Store;
let manager: DiffpackManager;
let projectId: string;
const tasks = new Map<string, Partial<Task>>();

const fakeTasks = {
  getByRef: async (ref: string) => (tasks.get(ref) as Task | undefined) ?? null,
} as unknown as TaskManager;

function deps() {
  return {
    store,
    diffpacks: { list: (id: string) => manager.listRecords(id) },
    tasks: fakeTasks,
  };
}

async function issue(path: string, message: string): Promise<string> {
  await store.observeProjectBoekwachterReviews(projectId, [
    { path, contentHash: 'h0', issues: [{ severity: 'major', category: 'bug', message }] },
  ]);
  const all = await store.listProjectBoekwachterIssues(projectId);
  return all.find((r) => r.path === path && r.message === message)!.ref;
}

async function status(ref: string) {
  const all = await store.listProjectBoekwachterIssues(projectId);
  const row = all.find((r) => r.ref === ref)!;
  return { status: row.status, taskRef: row.taskRef };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-issue-lifecycle-'));
  store = new Store({ home });
  await store.ensureLayout();
  projectId = (await store.createProject({ name: 'App' })).id;
  const wd = await store.projectWorkspaceDir(projectId);
  await mkdir(join(wd, 'src'), { recursive: true });
  await writeFile(join(wd, 'src/a.ts'), 'const a = 1;\n');
  await writeFile(join(wd, 'src/b.ts'), 'const b = 1;\n');
  tasks.clear();
  // Host 3 claimed the issues; shard 4 drafted the proposal.
  tasks.set(`${projectId}/3`, { ref: `${projectId}/3` });
  tasks.set(`${projectId}/4`, { ref: `${projectId}/4`, parentTaskRef: `${projectId}/3` });
  manager = new DiffpackManager({ home, store, tasks: fakeTasks });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function claim(ref: string) {
  await store.updateProjectBoekwachterIssue(projectId, ref, {
    status: 'in_progress',
    taskRef: `${projectId}/3`,
  });
}

async function proposeFixForA() {
  await manager.ensure(projectId, '4', {
    title: 'Fix a',
    origin: { kind: 'manual' },
    taskRef: `${projectId}/4`,
  });
  await manager.drafts.write(projectId, '4', 'src/a.ts', 'const a = 2;\n');
  return manager.seal(projectId, '4');
}

describe('Boekwachter issues follow the proposal', () => {
  it('keeps a proposed fix in progress, reopens what nothing proposed, and resolves on apply', async () => {
    const onA = await issue('src/a.ts', 'a is wrong');
    const onB = await issue('src/b.ts', 'b is wrong');
    await claim(onA);
    await claim(onB);
    const pack = await proposeFixForA();

    await settleIssuesForDraftingTask(deps(), projectId, `${projectId}/3`);
    expect(await status(onA)).toEqual({ status: 'in_progress', taskRef: `${projectId}/3` });
    expect((await status(onB)).status).toBe('open');

    await resolveIssuesForAppliedFiles(deps(), projectId, pack, ['src/a.ts']);
    expect((await status(onA)).status).toBe('resolved');
  });

  it('reopens the issues a dismissed proposal held', async () => {
    const onA = await issue('src/a.ts', 'a is wrong');
    await claim(onA);
    const pack = await proposeFixForA();
    await settleIssuesForDraftingTask(deps(), projectId, `${projectId}/3`);

    await manager.dismiss(projectId, '4');
    await reopenIssuesForDismissedPack(deps(), projectId, { ...pack, status: 'dismissed' });

    expect(await status(onA)).toEqual({ status: 'open', taskRef: undefined });
  });
});
