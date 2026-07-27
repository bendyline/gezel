import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import { TaskManager } from './manager.js';

let home: string;
let store: Store;
let history: HistoryManager;
let tasks: TaskManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-draft-'));
  history = new HistoryManager(home);
  store = new Store({ home, history });
  await store.ensureLayout();
  await store.createProject({ name: 'Website' });
  tasks = new TaskManager(store, history);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function draftInput() {
  return {
    title: 'Plan',
    status: 'draft' as const,
    assignee: { kind: 'user' as const },
    steps: [{ name: 'Build' }],
  };
}

describe('TaskManager — draft + activate', () => {
  it('creates a draft inert: status draft, entry step not bumped', async () => {
    const t = await tasks.create('website', draftInput());
    expect(t.status).toBe('draft');
    expect(t.activeStepId).toBe(t.craftbook.entryStepId);
    // Not activated → no attempt bump, no role resolution.
    expect(t.craftbook.steps[0]?.attemptCount).toBeUndefined();
  });

  it('activate(force) flips to active, bumps the entry step, and fires the handoff hook', async () => {
    let activated = 0;
    tasks.setStepActivatedHook(async () => {
      activated++;
    });
    const draft = await tasks.create('website', draftInput());
    expect(activated).toBe(0); // creating a draft dispatches nothing

    const live = await tasks.activate('website', draft.num, { force: true });
    expect(live.status).toBe('active');
    expect(live.craftbook.steps[0]?.attemptCount).toBe(1);
    expect(activated).toBe(1);
  });

  it('refuses to activate a structurally-thin plan without force', async () => {
    const draft = await tasks.create('website', draftInput());
    await expect(tasks.activate('website', draft.num)).rejects.toThrow(/not ready to activate/);
  });

  it('guards draft status transitions (must activate or cancel)', async () => {
    const draft = await tasks.create('website', draftInput());
    await expect(tasks.setStatus('website', draft.num, 'complete')).rejects.toThrow(/activated/);
    const canceled = await tasks.setStatus('website', draft.num, 'canceled');
    expect(canceled.status).toBe('canceled');
  });

  it('cannot move a live task back to draft', async () => {
    const live = await tasks.create('website', {
      title: 'Live',
      assignee: { kind: 'user' },
      steps: [{ name: 'Build' }],
    });
    await expect(tasks.setStatus('website', live.num, 'draft')).rejects.toThrow(/back to draft/);
  });

  it('activate rejects a non-draft task', async () => {
    const live = await tasks.create('website', {
      title: 'Live',
      assignee: { kind: 'user' },
      steps: [{ name: 'Build' }],
    });
    await expect(tasks.activate('website', live.num)).rejects.toThrow(/only a draft/);
  });

  it('a project whose only task is a draft is not stabilized', async () => {
    await tasks.create('website', draftInput());
    await tasks.maybeStabilizeProject('website');
    const project = await store.getProject('website');
    expect(project?.status).not.toBe('stable');
  });

  it('activates a catalog-craftbook draft without force despite thin-plan guardrails', async () => {
    // A curated book: one bare step, no outcomes, no verification — a shape
    // that would trip every planGuardrails heuristic on a hand-authored plan.
    tasks.setCraftbookResolver({
      resolve: async () => ({
        craftbook: {
          id: 'code-review',
          name: 'Code Review',
          steps: [{ id: 'review', name: 'Review' }],
          entryStepId: 'review',
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
        },
        sourceId: 'bundled',
        version: '1.0.0',
      }),
    });
    const draft = await tasks.create('website', {
      title: 'Review the site',
      status: 'draft',
      assignee: { kind: 'user' },
      craftbookId: 'code-review',
    });
    expect(draft.status).toBe('draft');
    expect(draft.sourceCraftbookIds?.[0]).toMatchObject({ role: 'main', catalogId: 'code-review' });

    const live = await tasks.activate('website', draft.num);
    expect(live.status).toBe('active');
    expect(live.craftbook.steps[0]?.attemptCount).toBe(1);
  });

  // The New Task dialog's craftbook path — creates a draft, fires later.
  it('a draft created without an assignee takes the entry-step role on activate', async () => {
    tasks.setRoleResolver(async (role) => ({ gezelId: `${role}-id` }));
    const draft = await tasks.create('website', {
      title: 'Review the contract',
      status: 'draft',
      steps: [{ name: 'Scope the review', suggestedRole: 'reviewer' }],
    });
    // Inert: no role resolved yet, so the owner is a placeholder.
    expect(draft.assignee).toEqual({ kind: 'user' });
    expect(draft.assigneeAuto).toBe(true);
    expect(draft.craftbook.steps[0]?.suggestedGezelId).toBeUndefined();

    const live = await tasks.activate('website', draft.num, { force: true });
    expect(live.craftbook.steps[0]?.suggestedGezelId).toBe('reviewer-id');
    expect(live.assignee).toEqual({ kind: 'gezel', gezelId: 'reviewer-id' });
  });

  it('activate leaves a hand-pinned draft assignee alone', async () => {
    tasks.setRoleResolver(async (role) => ({ gezelId: `${role}-id` }));
    const draft = await tasks.create('website', {
      title: 'Review the contract',
      status: 'draft',
      assignee: { kind: 'gezel', gezelId: 'magnus' },
      steps: [{ name: 'Scope the review', suggestedRole: 'reviewer' }],
    });
    const live = await tasks.activate('website', draft.num, { force: true });
    expect(live.assignee).toEqual({ kind: 'gezel', gezelId: 'magnus' });
    expect(live.craftbook.steps[0]?.suggestedGezelId).toBe('reviewer-id');
  });
});
