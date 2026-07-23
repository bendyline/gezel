import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { TaskManager } from './manager.js';

// The project lifecycle state machine driven by task ops:
//   - last active task closes (complete/cancel)  → project `stable`
//   - any new / resumed / edited task            → project back to `active`
// This is what stops the scheduler nagging a finished project (the
// qwen3.6 "Space Shooter Arcade" spin) without the user or a weak local
// model needing to take an explicit action.

let home: string;
let store: Store;
let tasks: TaskManager;

const statusOf = async (id: string) => (await store.getProject(id))?.status;

const seedTask = (title: string) =>
  tasks.create('website', { title, assignee: { kind: 'user' }, steps: [{ name: 'Main' }] });

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-proj-lifecycle-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.createProject({ name: 'Website' });
  tasks = new TaskManager(store);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('TaskManager — project lifecycle (stable ⇄ active)', () => {
  it('completing the last active task brings the project to rest (stable)', async () => {
    const t = await seedTask('Ship it');
    expect(await statusOf('website')).not.toBe('stable'); // active/unset
    await tasks.setStatus('website', t.num, 'complete');
    expect(await statusOf('website')).toBe('stable');
  });

  it('canceling the last active task also stabilizes', async () => {
    const t = await seedTask('Scrap it');
    await tasks.setStatus('website', t.num, 'canceled');
    expect(await statusOf('website')).toBe('stable');
  });

  it('does NOT stabilize while another task is still active', async () => {
    const a = await seedTask('A');
    await seedTask('B'); // B stays active
    await tasks.setStatus('website', a.num, 'complete');
    expect(await statusOf('website')).not.toBe('stable');
  });

  it('creating a task on a stable project flips it back to active', async () => {
    const t = await seedTask('First');
    await tasks.setStatus('website', t.num, 'complete');
    expect(await statusOf('website')).toBe('stable');

    await seedTask('More work'); // new task = live work
    expect(await statusOf('website')).toBe('active');
  });

  it('reopening a completed task (status → active/paused) wakes the project', async () => {
    const t = await seedTask('First');
    await tasks.setStatus('website', t.num, 'complete');
    expect(await statusOf('website')).toBe('stable');

    await tasks.setStatus('website', t.num, 'active');
    expect(await statusOf('website')).toBe('active');
  });

  it('editing a task (a non-closing update) wakes a stable project', async () => {
    const t = await seedTask('First');
    await tasks.setStatus('website', t.num, 'complete');
    expect(await statusOf('website')).toBe('stable');

    await tasks.update('website', t.num, { title: 'First (revised)' });
    expect(await statusOf('website')).toBe('active');
  });

  it('adding a step wakes a stable project', async () => {
    const t = await seedTask('First');
    await tasks.setStatus('website', t.num, 'complete');
    expect(await statusOf('website')).toBe('stable');

    await tasks.addStep('website', t.num, { name: 'Follow-up' });
    expect(await statusOf('website')).toBe('active');
  });

  it('completing a terminal step stabilizes; advancing to a next step keeps it active', async () => {
    // Two-step craftbook: completing step 1 advances (active), completing
    // the terminal step 2 closes the task (stable).
    const t = await tasks.create('website', {
      title: 'Two-phase',
      assignee: { kind: 'user' },
      steps: [{ name: 'Build' }, { name: 'Ship', terminal: true }],
    });
    await tasks.completeStep('website', t.num, t.craftbook.steps[0]!.id);
    expect(await statusOf('website')).not.toBe('stable'); // advanced, still live

    const mid = await store.readTask('website', t.num);
    await tasks.completeStep('website', t.num, mid!.activeStepId!);
    expect(await statusOf('website')).toBe('stable'); // terminal step closed it
  });

  it('re-closing an already-complete task heals a project stuck `active`', async () => {
    const t = await seedTask('Ship it');
    await tasks.setStatus('website', t.num, 'complete');
    expect(await statusOf('website')).toBe('stable');

    // Simulate the stuck state: status forced back to `active` while the
    // only task stays complete (a stabilization that raced, or a project
    // that predates the stable lifecycle). The old unconditional
    // early-return on a no-op transition made this unhealable — the
    // voorman re-closing the task never re-ran stabilization, and the
    // meester nudged the finished project forever.
    await store.updateProject('website', { status: 'active' });
    await tasks.setStatus('website', t.num, 'complete'); // same status — no transition
    expect(await statusOf('website')).toBe('stable');
  });

  it('leaves deliberate user pauses (readonly/inactive) untouched', async () => {
    // A user parked the project as readonly. A task edit must NOT silently
    // override that choice — only the soft, lifecycle-owned `stable` is
    // ours to clear.
    const t = await seedTask('First');
    await store.updateProject('website', { status: 'readonly' });

    // A non-closing op would wake `stable`, but must leave `readonly` alone.
    await tasks.update('website', t.num, { title: 'edited' });
    expect(await statusOf('website')).toBe('readonly');

    // And closing the last task must not flip readonly → stable either.
    await tasks.setStatus('website', t.num, 'complete');
    expect(await statusOf('website')).toBe('readonly');
  });
});
