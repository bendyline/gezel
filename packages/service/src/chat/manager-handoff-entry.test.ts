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
import { dispatchTaskEntry } from '../tasks/entry-dispatch.js';
import { TaskManager } from '../tasks/manager.js';
import { TaskRunner } from '../tasks/runner.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

/**
 * The D1 single-channel kickoff, end to end: create a task, dispatch
 * its entry step through the real TaskRunner, and prove the worker
 * lands in a TASK-SCOPED session — taskRef/stepId on the record, the
 * step procedure + gate contract in the system prompt, the entry-kind
 * seed message, and Theme C capability-floor routing firing for step 1
 * (developer role → small floor → routed off the 27b default).
 */

const noopMemory = {
  save: async () => {},
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

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
let tasks: TaskManager;
let runner: TaskRunner;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-handoff-entry-'));
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
  tasks = new TaskManager(store, history);
  runner = new TaskRunner({
    store,
    dispatcher: {
      startHandoffSession: (args) => manager.startHandoffSession(args),
      resolveProviderName: async () => 'llama-cpp',
      getProvider: () => mock,
    },
  });
});

afterEach(async () => {
  await manager.drainBackground();
  await manager.shutdown().catch(() => {});
  await rm(home, { recursive: true, force: true });
});

describe('single-channel kickoff (D1)', () => {
  it('dispatched entry lands in a task-scoped session with the contract in-prompt and step-1 routing', async () => {
    const task = await tasks.create('p1', {
      title: 'Build the landing page',
      description:
        'A single-channel kickoff fixture: one developer-shaped build step with an enforced deliverable gate.',
      assignee: { kind: 'gezel', gezelId: 'worker' },
      steps: [
        {
          name: 'Build',
          prompt: 'Write the landing page to index.html using writeFile.',
          suggestedRole: 'developer',
          deliverable: { path: 'index.html' },
        },
        { name: 'Ship', assignee: { kind: 'user' } },
      ],
      createdBy: { kind: 'user' },
    });

    mock.script('ok');
    const dispatch = await dispatchTaskEntry({ store, taskRunner: runner, history }, task);
    expect(dispatch.enqueued).toBe(true);
    expect(dispatch.gezelId).toBe('worker');
    await runner.tick();
    await manager.drainBackground();

    // 1. The worker session is task-scoped.
    const sessions = await store.listSessions({ gezelId: 'worker' });
    const workerSession = sessions.find((s) => s.taskRef === task.ref);
    expect(workerSession).toBeDefined();
    expect(workerSession?.stepId).toBe(task.craftbook.steps[0]?.id);

    // 2. The system prompt carries the step procedure + gate contract.
    // Task context rides the volatile band when layered prefix caching
    // is on — assert against the stable + volatile prompt together.
    const create = mock.calls.find((c) => c.kind === 'create');
    const prompt = `${create?.opts?.systemMessage ?? ''}\n${create?.opts?.volatileContext ?? ''}`;
    expect(prompt).toContain('Step procedure');
    expect(prompt).toContain('Write the landing page');
    expect(prompt).toContain('Phase gate');

    // 3. The seed is the entry-kind wording with the step arc.
    const full = await store.getSession('worker', workerSession?.id ?? '');
    const seed = full?.messages[0]?.content ?? '';
    expect(seed).toContain("You've been assigned task");
    expect(seed).toContain('← your step');

    // 4. Theme C floor routing fired for step 1 (developer → small → 8b).
    expect(full?.model).toBe('worker-8b');
    const routed = await history.listEvents({ kinds: ['task.step.routed'] });
    expect(routed).toHaveLength(1);
    expect(routed[0]?.details).toMatchObject({ ref: task.ref, model: 'worker-8b' });

    // 5. And the kickoff story is on the history log — no chat notify.
    const dispatched = await history.listEvents({ kinds: ['task.entry.dispatched'] });
    expect(dispatched).toHaveLength(1);
    const messaged = await history.listEvents({ kinds: ['gezel.messaged'] });
    expect(messaged).toHaveLength(0);
  });
});
