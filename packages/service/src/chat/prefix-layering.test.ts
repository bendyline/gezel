import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

/**
 * Behavioral tests for the layered prompt-prefix cache flag
 * (`config.layeredPrefixCache`). Contract:
 *
 *   - LOCAL-ENGINE ONLY: the flag restructures the prompt (volatile band →
 *     a second `system` message) which only the llama-cpp / mlx provider
 *     sessions seed. Cloud providers must NEVER be restructured (they'd
 *     drop the volatile band).
 *   - Default per-engine: ON for `llama-cpp`, OFF for `mlx`; `enabled` in
 *     config overrides both; `GEZEL_LAYERED_PREFIX_CACHE` overrides config.
 *   - ON → `systemMessage` is PURELY STABLE, the volatile band rides in
 *     `volatileContext`, and `systemPromptLayers` carries `gezel ⊂ project`.
 *   - #1 (the win): stable system + `layers.project` are byte-IDENTICAL
 *     across sessions of the same (gezel, project) even when the volatile
 *     band differs — the cache key no longer churns on volatile content.
 */

const noopMemory = {
  save: async () => {},
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

let home: string;
let store: Store;
let events: ChatEventBus;
let llamaMock: MockProvider;
let cloudMock: MockProvider;

async function makeManager(): Promise<ChatManager> {
  return new ChatManager({
    store,
    events,
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    providers: [
      ['llama-cpp', llamaMock],
      ['copilot', cloudMock],
    ],
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-prefix-layer-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.createGezel({ name: 'Ada', role: 'Developer' });
  events = new ChatEventBus();
  llamaMock = new MockProvider({ name: 'llama-cpp' });
  cloudMock = new MockProvider({ name: 'copilot' });
});

afterEach(async () => {
  // MCP subprocess teardown can finish releasing files just after the
  // manager disconnects under full-suite load. Retry the recursive walk
  // instead of surfacing that harmless overlap as ENOTEMPTY.
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function createTask(projectId: string, title: string) {
  const { TaskManager } = await import('../tasks/manager.js');
  const taskMgr = new TaskManager(store);
  return taskMgr.create(projectId, {
    title,
    assignee: { kind: 'gezel', gezelId: 'ada' },
    steps: [{ name: 'Build' }],
  });
}

function findCreateOpts(mock: MockProvider) {
  return mock.calls.find(
    (c) => c.kind === 'create' && !!c.opts?.systemMessage.startsWith('You are acting as the agent'),
  )!.opts!;
}

describe('layered prefix cache — gating', () => {
  it('llama-cpp defaults ON: moves the volatile band out and exposes gezel ⊂ project layers', async () => {
    await store.writeConfig({ provider: 'llama-cpp' });
    const proj = await store.createProject({ name: 'Shop' });
    const task = await createTask(proj.id, 'Build the storefront');
    const manager = await makeManager();
    try {
      const session = await manager.createSession({
        gezelId: 'ada',
        projectId: proj.id,
        taskRef: task.ref,
        stepId: task.activeStepId,
      });
      llamaMock.script('ok');
      await manager.send(session.id, 'start');
      const opts = findCreateOpts(llamaMock);

      expect(opts.systemMessage).not.toContain('### Current task: ');
      expect(opts.volatileContext).toBeDefined();
      expect(opts.volatileContext).toContain('### Current task: ');
      expect(opts.volatileContext).toContain('Build the storefront');

      const layers = opts.systemPromptLayers;
      expect(layers).toBeDefined();
      // gezel identity is a true byte-prefix of the full stable `project`
      // layer, and `project` carries the late discipline/tools bands too.
      expect(layers!.project.startsWith(layers!.gezel)).toBe(true);
      expect(layers!.project.length).toBeGreaterThan(layers!.gezel.length);
      expect(layers!.project).toContain("Act, don't narrate");
      expect(layers!.gezel).toContain('Ada');
      expect(layers!.gezel).not.toContain('Build the storefront');
      // The system message sent to the engine is the stable `project` layer
      // (volatile-free) — same identity prefix, no task content.
      expect(opts.systemMessage.startsWith(layers!.gezel)).toBe(true);
    } finally {
      await manager.drainBackground();
      await manager.shutdown();
    }
  });

  it('explicit { enabled: false } disables it for llama-cpp (legacy inline, no layers)', async () => {
    await store.writeConfig({ provider: 'llama-cpp', layeredPrefixCache: { enabled: false } });
    const proj = await store.createProject({ name: 'Shop' });
    const task = await createTask(proj.id, 'Build the storefront');
    const manager = await makeManager();
    try {
      const session = await manager.createSession({
        gezelId: 'ada',
        projectId: proj.id,
        taskRef: task.ref,
        stepId: task.activeStepId,
      });
      llamaMock.script('ok');
      await manager.send(session.id, 'start');
      const opts = findCreateOpts(llamaMock);
      expect(opts.systemMessage).toContain('### Current task: ');
      expect(opts.systemPromptLayers).toBeUndefined();
      expect(opts.volatileContext).toBeUndefined();
    } finally {
      await manager.drainBackground();
      await manager.shutdown();
    }
  });

  // The 30s budget: this integration path starts a real MCP subprocess. It is
  // sub-second alone but can cross the project's 10s default at the tail of the
  // full service suite, where other subprocess-heavy files have the same budget.
  it('NEVER restructures a cloud provider, even with { enabled: true }', async () => {
    await store.writeConfig({ provider: 'copilot', layeredPrefixCache: { enabled: true } });
    const proj = await store.createProject({ name: 'Shop' });
    const task = await createTask(proj.id, 'Build the storefront');
    const manager = await makeManager();
    try {
      const session = await manager.createSession({
        gezelId: 'ada',
        projectId: proj.id,
        taskRef: task.ref,
        stepId: task.activeStepId,
      });
      cloudMock.script('ok');
      await manager.send(session.id, 'start');
      const opts = findCreateOpts(cloudMock);
      // Cloud session keeps the volatile band INLINE — it must not be split
      // out (the cloud provider would drop the second message).
      expect(opts.systemMessage).toContain('### Current task: ');
      expect(opts.systemPromptLayers).toBeUndefined();
      expect(opts.volatileContext).toBeUndefined();
    } finally {
      await manager.drainBackground();
      await manager.shutdown();
    }
  }, 30_000);

  it('keeps the stable prefix byte-identical across sessions with different volatile state (#1)', async () => {
    await store.writeConfig({ provider: 'llama-cpp' });
    const proj = await store.createProject({ name: 'Shop' });
    const t1 = await createTask(proj.id, 'Build the storefront');
    const t2 = await createTask(proj.id, 'Wire up checkout');
    const manager = await makeManager();
    try {
      const s1 = await manager.createSession({
        gezelId: 'ada',
        projectId: proj.id,
        taskRef: t1.ref,
        stepId: t1.activeStepId,
      });
      llamaMock.script('ok');
      await manager.send(s1.id, 'start');
      const opts1 = findCreateOpts(llamaMock);

      llamaMock.calls.length = 0;
      const s2 = await manager.createSession({
        gezelId: 'ada',
        projectId: proj.id,
        taskRef: t2.ref,
        stepId: t2.activeStepId,
      });
      llamaMock.script('ok');
      await manager.send(s2.id, 'start');
      const opts2 = findCreateOpts(llamaMock);

      expect(opts1.systemMessage).toBe(opts2.systemMessage);
      expect(opts1.systemPromptLayers!.project).toBe(opts2.systemPromptLayers!.project);
      expect(opts1.volatileContext).not.toBe(opts2.volatileContext);
      expect(opts1.volatileContext).toContain('Build the storefront');
      expect(opts2.volatileContext).toContain('Wire up checkout');
    } finally {
      await manager.drainBackground();
      await manager.shutdown();
    }
  });
});
