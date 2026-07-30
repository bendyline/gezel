import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { TaskManager } from '../tasks/manager.js';
import { INDEXING_JOB_TITLE, IndexingJobControl, ensureIndexingJobTask } from './indexing-job.js';

let home: string;
let store: Store;
let tasks: TaskManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-idxjob-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.ensureDefaultProject();
  const boekwachter = await store.createGezel({
    name: 'Noor',
    role: 'Boekwachter',
    about: 'You keep the index concise.',
  });
  await store.writeConfig({ boekwachterGezelId: boekwachter.id });
  tasks = new TaskManager(store);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('indexing job task', () => {
  it('installs once, as a user-assigned (never-dispatched) active task', async () => {
    await ensureIndexingJobTask(store, tasks);
    await ensureIndexingJobTask(store, tasks);
    const all = await store.listProjectTasks('default');
    const jobs = all.filter((t) => t.title === INDEXING_JOB_TITLE);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.assignee).toEqual({ kind: 'user' });
    expect(jobs[0]?.status).toBe('active');
    expect(jobs[0]?.origin).toEqual({
      kind: 'system-job',
      jobId: 'boekwachter-indexing',
      managedByGezelId: 'noor',
    });
  });

  it('pausing the task pauses the loops via IndexingJobControl', async () => {
    await ensureIndexingJobTask(store, tasks);
    const control = new IndexingJobControl(store, tasks);
    expect(await control.isPaused()).toBe(false);

    const job = (await store.listProjectTasks('default')).find(
      (t) => t.title === INDEXING_JOB_TITLE,
    )!;
    await tasks.setStatus('default', job.num, 'paused');
    control.invalidate();
    expect(await control.isPaused()).toBe(true);

    await tasks.setStatus('default', job.num, 'active');
    control.invalidate();
    expect(await control.isPaused()).toBe(false);
  });

  it('is never paused when the control task is missing', async () => {
    const control = new IndexingJobControl(store);
    expect(await control.isPaused()).toBe(false);
  });

  it('cannot be reassigned or closed like a model-dispatched task', async () => {
    await ensureIndexingJobTask(store, tasks);
    const job = (await store.listProjectTasks('default')).find(
      (task) => task.title === INDEXING_JOB_TITLE,
    )!;

    await expect(
      tasks.update('default', job.num, {
        assignee: { kind: 'gezel', gezelId: 'noor' },
      }),
    ).rejects.toThrow(/system jobs.*cannot be reassigned/i);
    await expect(tasks.setStatus('default', job.num, 'complete')).rejects.toThrow(
      /only be active or paused/i,
    );
  });

  it('note() appends a visible progress note to the job task', async () => {
    await ensureIndexingJobTask(store, tasks);
    const control = new IndexingJobControl(store, tasks);
    await control.note('Weekly digest sweep: 2 generated.');
    const job = (await store.listProjectTasks('default')).find(
      (t) => t.title === INDEXING_JOB_TITLE,
    )!;
    const notes = await tasks.listNotes('default', job.num);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain('2 generated');
    expect(notes[0]?.author).toMatchObject({ kind: 'gezel', gezelId: 'noor', name: 'Noor' });
  });
});
