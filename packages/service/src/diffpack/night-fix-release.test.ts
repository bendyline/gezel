import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import { TaskManager } from '../tasks/manager.js';
import { releaseStaleNightFixes } from './night-fix-planner.js';

let home: string;
let store: Store;
let tasks: TaskManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-night-fix-release-'));
  const history = new HistoryManager(home);
  store = new Store({ home, history });
  await store.ensureLayout();
  await store.ensureDefaultProject();
  tasks = new TaskManager(store, history);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const WINDOW_START = Date.parse('2026-10-09T05:00:00Z');
const EARLIER_NIGHT = '2026-10-08T09:00:00.000Z';
const TONIGHT = '2026-10-09T06:00:00.000Z';

async function make(
  title: string,
  opts: { sweep?: boolean; status: Task['status']; updatedAt: string; parentTaskRef?: string },
): Promise<Task> {
  const created = await tasks.create(
    'default',
    {
      title,
      assignee: { kind: 'user' },
      steps: [{ id: 'triage', name: 'Triage', prompt: 'Triage the leads.' }],
      entryStepId: 'triage',
      ...(opts.sweep ? { nightShift: { enabled: true, onceADay: true } } : {}),
    },
    opts.sweep
      ? { origin: { kind: 'boekwachter-issue', issueRef: 'BW-1', path: 'src/a.ts' } }
      : undefined,
  );
  const saved = (await store.readTask('default', created.num))!;
  const next = {
    ...saved,
    status: opts.status,
    updatedAt: opts.updatedAt,
    ...(opts.parentTaskRef ? { parentTaskRef: opts.parentTaskRef } : {}),
  };
  await store.writeTask(next);
  return next;
}

// A paused sweep held its issues forever: gezel-site/5 sat on 40 of them, and
// the planner skips claimed issues (2026-10-09).
describe('releasing paused night fix sweeps', () => {
  it('cancels a sweep paused on an earlier night, and only that', async () => {
    const stale = await make('Nightly fixes — 40 open issues', {
      sweep: true,
      status: 'paused',
      updatedAt: EARLIER_NIGHT,
    });
    const tonight = await make('Nightly fixes — 3 open issues', {
      sweep: true,
      status: 'paused',
      updatedAt: TONIGHT,
    });
    const proposed = await make('Nightly fixes — 5 open issues', {
      sweep: true,
      status: 'paused',
      updatedAt: EARLIER_NIGHT,
    });
    await make('Guard the null token', {
      status: 'complete',
      updatedAt: EARLIER_NIGHT,
      parentTaskRef: proposed.ref,
    });
    const own = await make('Plan the launch', { status: 'paused', updatedAt: EARLIER_NIGHT });

    const released = await releaseStaleNightFixes({ store, tasks }, WINDOW_START);

    expect(released).toEqual([stale.ref]);
    const status = async (t: Task) => (await store.readTask('default', t.num))?.status;
    expect(await status(stale)).toBe('canceled');
    expect(await status(tonight)).toBe('paused');
    expect(await status(proposed)).toBe('paused');
    expect(await status(own)).toBe('paused');
  });

  // gezel-site/8 stayed active behind a question nobody was awake to answer.
  it('also releases a sweep stuck active since an earlier night, and withdraws its question', async () => {
    const stuck = await make('Nightly fixes — 3 open issues', {
      sweep: true,
      status: 'active',
      updatedAt: EARLIER_NIGHT,
    });
    await store.writeQuestion({
      id: 'q-stuck',
      projectId: 'default',
      gezelId: 'esra',
      sessionId: 'sweep-session',
      prompt: 'Workspace writes are disabled. What should I do?',
      choices: ['Allow project file edits and continue', 'Keep current permissions'],
      allowWriteIn: false,
      multiSelect: false,
      taskRef: stuck.ref,
      createdAt: EARLIER_NIGHT,
    });

    expect(await releaseStaleNightFixes({ store, tasks }, WINDOW_START)).toEqual([stuck.ref]);
    expect((await store.readTask('default', stuck.num))?.status).toBe('canceled');
    expect((await store.getQuestion('default', 'q-stuck'))?.answer?.silentSkip).toBe(true);
  });
});
