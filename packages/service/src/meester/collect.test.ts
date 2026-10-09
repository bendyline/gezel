import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActivityTracker } from '../fs/activity-tracker.js';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import { TaskManager } from '../tasks/manager.js';
import { collectProjectContexts } from './collect.js';

let home: string;
let store: Store;
let history: HistoryManager;
let tasks: TaskManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-collect-'));
  history = new HistoryManager(home);
  store = new Store({ home, history });
  await store.ensureLayout();
  await store.ensureDefaultProject();
  tasks = new TaskManager(store, history);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// The status line drafted follow-up chores about paused night fix sweeps
// (2026-10-08, 2026-10-09). The runtime's own night work is not the person's.
describe('what the Meester status line sees', () => {
  it("leaves out the runtime's night fix sweep and keeps the person's tasks", async () => {
    await tasks.create(
      'default',
      {
        title: 'Nightly fixes — 40 open issues',
        assignee: { kind: 'user' },
        steps: [{ id: 'triage', name: 'Triage', prompt: 'Triage the leads.' }],
        entryStepId: 'triage',
        nightShift: { enabled: true, onceADay: true },
      },
      { origin: { kind: 'boekwachter-issue', issueRef: 'BW-1', path: 'src/a.ts' } },
    );
    await tasks.create('default', {
      title: 'Plan the launch',
      assignee: { kind: 'user' },
      steps: [{ id: 'plan', name: 'Plan', prompt: 'Plan it.' }],
      entryStepId: 'plan',
    });

    const contexts = await collectProjectContexts(
      {
        store,
        history,
        activity: { lastActivityAt: async () => null } as unknown as ActivityTracker,
      },
      { now: new Date(), excludeEventKinds: [] },
    );

    const titles = contexts.flatMap((c) => c.openTasks.map((t) => t.title));
    expect(titles).toContain('Plan the launch');
    expect(titles).not.toContain('Nightly fixes — 40 open issues');
  });
});
