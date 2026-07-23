import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import type { MemoryManager } from '../memory/manager.js';
import type { LlamaCppModelManager } from '../providers/llama-cpp/index.js';
import { MockProvider } from '../providers/mock.js';
import type { LLMProvider } from '../providers/types.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

const noopMemory = {
  save: async () => {},
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

/**
 * Fleet fixture. Model ids carry their size so `classifyModelTier`'s
 * id-parsing fallback works without a populated catalog: worker-8b →
 * small, brain-27b → medium.
 */
function fakeLlamaModels(): LlamaCppModelManager {
  const models = [
    { id: 'worker-8b', name: 'Worker 8B', approxSizeBytes: 5e9 },
    { id: 'brain-27b', name: 'Brain 27B', approxSizeBytes: 17e9 },
  ];
  return {
    listInstalled: async () => models,
    resolveModel: async (id: string) => models.find((m) => m.id === id) ?? null,
  } as unknown as LlamaCppModelManager;
}

/**
 * Structural EngineRouter fake: replica picks and binds resolve to the
 * seeded MockProvider so no real llama-server is ever spawned; the
 * pool snapshot is empty (nothing resident).
 */
function fakeRouter(provider: LLMProvider) {
  const snapshot = () => ({ entries: [], committedBytes: 0, budgetBytes: 0, enforced: false });
  return {
    pool: { pickReplicaForBind: () => 0, snapshot },
    snapshot,
    bindForSession: async (name: string, modelId: string) => ({
      engineKey: `${name}:${modelId}:0`,
      provider,
    }),
  } as unknown as import('../providers/native/engine-router.js').EngineRouter;
}

let home: string;
let store: Store;
let history: HistoryManager;
let mock: MockProvider;
let manager: ChatManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-routing-'));
  history = new HistoryManager(home);
  store = new Store({ home, history });
  await store.ensureLayout();
  await store.createProject({ name: 'p1' });
  await store.createGezel({ name: 'Worker' });
  await store.writeConfig({
    provider: 'llama-cpp',
    defaultModel: { 'llama-cpp': 'brain-27b' },
  });
  mock = new MockProvider({ name: 'llama-cpp' });
  manager = new ChatManager({
    store,
    events: new ChatEventBus(),
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    providers: [['llama-cpp', mock]],
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
    history,
    llamaCppModels: fakeLlamaModels(),
    engineRouter: fakeRouter(mock),
  });
  delete process.env.GEZEL_DISABLE_MODEL_ROUTING;
});

afterEach(async () => {
  delete process.env.GEZEL_DISABLE_MODEL_ROUTING;
  await manager.drainBackground();
  await manager.shutdown().catch(() => {});
  await rm(home, { recursive: true, force: true });
});

async function routedEvents() {
  return history.listEvents({ kinds: ['task.step.routed'] });
}

describe('createSession routedModel precedence', () => {
  const routed = {
    provider: 'llama-cpp' as const,
    model: 'worker-8b',
    capabilityFloor: 'small' as const,
    reason: 'test',
  };

  it('routedModel replaces the config default', async () => {
    const session = await manager.createSession({ gezelId: 'worker', routedModel: routed });
    expect(session.model).toBe('worker-8b');
  });

  it('a frontmatter model pin wins over routedModel', async () => {
    await store.updateGezelSettings('worker', { model: 'pinned-13b' });
    const session = await manager.createSession({ gezelId: 'worker', routedModel: routed });
    expect(session.model).toBe('pinned-13b');
  });

  it('a cross-provider routedModel is inert', async () => {
    const session = await manager.createSession({
      gezelId: 'worker',
      routedModel: { ...routed, provider: 'mlx' },
    });
    expect(session.model).toBe('brain-27b');
  });
});

describe('startHandoffSession capability-floor routing', () => {
  it('floor=small routes the worker session off the 27b default onto the 8b', async () => {
    mock.script('ok');
    const { sessionId } = await manager.startHandoffSession({
      gezelId: 'worker',
      projectId: 'p1',
      taskRef: 'p1/1',
      stepId: 'build',
      capabilityFloor: 'small',
      bookCatalogId: 'cb-test',
    });
    const session = await store.getSession('worker', sessionId);
    expect(session?.model).toBe('worker-8b');

    const events = await routedEvents();
    expect(events).toHaveLength(1);
    const details = events[0]?.details as Record<string, unknown>;
    expect(details.model).toBe('worker-8b');
    expect(details.stepId).toBe('build');
    expect(details.capabilityFloor).toBe('small');
    expect(details.defaultModel).toBe('brain-27b');
  });

  it('floor=medium keeps the default (pick === default → no override, no event)', async () => {
    mock.script('ok');
    const { sessionId } = await manager.startHandoffSession({
      gezelId: 'worker',
      projectId: 'p1',
      taskRef: 'p1/1',
      stepId: 'review',
      capabilityFloor: 'medium',
    });
    const session = await store.getSession('worker', sessionId);
    expect(session?.model).toBe('brain-27b');
    expect(await routedEvents()).toHaveLength(0);
  });

  it('an explicit Night Shift model default suppresses cheaper capability routing', async () => {
    await store.writeConfig({
      nightShift: {
        modelOverride: { enabled: true, provider: 'llama-cpp', model: 'brain-27b' },
      },
    });
    mock.script('ok');
    const { sessionId } = await manager.startHandoffSession({
      gezelId: 'worker',
      projectId: 'p1',
      taskRef: 'p1/1',
      stepId: 'build',
      capabilityFloor: 'small',
      nightShift: true,
    });

    const session = await store.getSession('worker', sessionId);
    expect(session?.model).toBe('brain-27b');
    expect(await routedEvents()).toHaveLength(0);
  });

  it('no floor → no routing at all', async () => {
    mock.script('ok');
    const { sessionId } = await manager.startHandoffSession({
      gezelId: 'worker',
      projectId: 'p1',
      taskRef: 'p1/1',
      stepId: 'build',
    });
    const session = await store.getSession('worker', sessionId);
    expect(session?.model).toBe('brain-27b');
    expect(await routedEvents()).toHaveLength(0);
  });

  it('a frontmatter pin suppresses routing even with a floor', async () => {
    await store.updateGezelSettings('worker', { model: 'pinned-2b' });
    mock.script('ok');
    const { sessionId } = await manager.startHandoffSession({
      gezelId: 'worker',
      projectId: 'p1',
      taskRef: 'p1/1',
      stepId: 'build',
      capabilityFloor: 'small',
    });
    const session = await store.getSession('worker', sessionId);
    expect(session?.model).toBe('pinned-2b');
    expect(await routedEvents()).toHaveLength(0);
  });

  it('GEZEL_DISABLE_MODEL_ROUTING=1 kills routing: default sticks, no event', async () => {
    process.env.GEZEL_DISABLE_MODEL_ROUTING = '1';
    mock.script('ok');
    const { sessionId } = await manager.startHandoffSession({
      gezelId: 'worker',
      projectId: 'p1',
      taskRef: 'p1/1',
      stepId: 'build',
      capabilityFloor: 'small',
      bookCatalogId: 'cb-test',
    });
    const session = await store.getSession('worker', sessionId);
    expect(session?.model).toBe('brain-27b');
    expect(await routedEvents()).toHaveLength(0);
  });
});

describe('startHandoffSession tier-collapse at dispatch (D3)', () => {
  const gatedSixStepTask = () => ({
    title: 'Long gallery build',
    description:
      'A six-step linear book fixture proving the tiny-tier collapse fires at handoff dispatch.',
    assignee: { kind: 'gezel' as const, gezelId: 'worker' },
    steps: [
      { name: 'Research', prompt: 'Gather inputs.' },
      {
        name: 'Draft',
        prompt: 'Write brief.md.',
        deliverable: { path: 'brief.md' },
      },
      { name: 'Illustrate', prompt: 'Add a diagram.' },
      {
        name: 'Build',
        prompt: 'Build index.html.',
        deliverable: { path: 'index.html' },
      },
      {
        name: 'Verify',
        prompt: 'Verify the page.',
        deliverable: { path: 'report.md' },
      },
      { name: 'Finish', prompt: 'Summarize.' },
    ],
    createdBy: { kind: 'user' as const },
  });

  async function wireTasks() {
    const { TaskManager } = await import('../tasks/manager.js');
    const tasks = new TaskManager(store, history);
    manager.setTierCollapser((projectId, num, opts) =>
      tasks.collapseCraftbookForTier(projectId, num, opts),
    );
    return tasks;
  }

  it('a tiny default model collapses the book before the worker session exists', async () => {
    // pocket-2b classifies tiny by id; no floor → no routing → the
    // config default is the effective executor.
    await store.writeConfig({
      provider: 'llama-cpp',
      defaultModel: { 'llama-cpp': 'pocket-2b' },
    });
    const tasks = await wireTasks();
    const task = await tasks.create('p1', gatedSixStepTask());
    expect(task.craftbook.steps).toHaveLength(6);

    mock.script('ok');
    const { sessionId } = await manager.startHandoffSession({
      gezelId: 'worker',
      projectId: 'p1',
      taskRef: task.ref,
      stepId: task.activeStepId ?? 'research',
    });
    await manager.drainBackground();

    const collapsed = await store.readTask('p1', task.num);
    expect(collapsed?.craftbook.steps.length).toBeLessThanOrEqual(3);
    expect(collapsed?.craftbook.renderedForTier).toBe('tiny');
    // The dispatched entry step (gateless 'research') mapped to its
    // merge anchor ('draft') on the session record.
    const session = await store.getSession('worker', sessionId);
    expect(session?.stepId).toBe('draft');
    const events = await history.listEvents({ kinds: ['task.craftbook.tier-collapsed'] });
    expect(events).toHaveLength(1);
    expect(events[0]?.details).toMatchObject({ ref: task.ref, fromSteps: 6 });
  });

  it('a medium default leaves the book as-authored', async () => {
    const tasks = await wireTasks();
    const task = await tasks.create('p1', gatedSixStepTask());
    mock.script('ok');
    await manager.startHandoffSession({
      gezelId: 'worker',
      projectId: 'p1',
      taskRef: task.ref,
      stepId: task.activeStepId ?? 'research',
    });
    await manager.drainBackground();
    const after = await store.readTask('p1', task.num);
    expect(after?.craftbook.steps).toHaveLength(6);
    expect(after?.craftbook.renderedForTier).toBeUndefined();
  });

  it('GEZEL_DISABLE_TIER_COLLAPSE=1 leaves a tiny dispatch untouched', async () => {
    process.env.GEZEL_DISABLE_TIER_COLLAPSE = '1';
    try {
      await store.writeConfig({
        provider: 'llama-cpp',
        defaultModel: { 'llama-cpp': 'pocket-2b' },
      });
      const tasks = await wireTasks();
      const task = await tasks.create('p1', gatedSixStepTask());
      mock.script('ok');
      await manager.startHandoffSession({
        gezelId: 'worker',
        projectId: 'p1',
        taskRef: task.ref,
        stepId: task.activeStepId ?? 'research',
      });
      await manager.drainBackground();
      const after = await store.readTask('p1', task.num);
      expect(after?.craftbook.steps).toHaveLength(6);
    } finally {
      delete process.env.GEZEL_DISABLE_TIER_COLLAPSE;
    }
  });

  it('a crew book (steps owned by another gezel) skips the collapse', async () => {
    await store.writeConfig({
      provider: 'llama-cpp',
      defaultModel: { 'llama-cpp': 'pocket-2b' },
    });
    await store.createGezel({ name: 'Other' });
    const tasks = await wireTasks();
    const fixture = gatedSixStepTask();
    (fixture.steps[3] as { assignee?: unknown }).assignee = {
      kind: 'gezel',
      gezelId: 'other',
    };
    const task = await tasks.create('p1', fixture);
    mock.script('ok');
    await manager.startHandoffSession({
      gezelId: 'worker',
      projectId: 'p1',
      taskRef: task.ref,
      stepId: task.activeStepId ?? 'research',
    });
    await manager.drainBackground();
    const after = await store.readTask('p1', task.num);
    expect(after?.craftbook.steps).toHaveLength(6);
    expect(after?.craftbook.renderedForTier).toBeUndefined();
  });
});
