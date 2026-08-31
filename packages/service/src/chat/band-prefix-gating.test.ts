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
 * Gating for shared-band prefix reuse (`config.mlxSharedBandPrefix`, ADR 0010).
 *
 * The default lives in one `??` in `buildInstructions`' caller and nothing else
 * observes it, so it is exactly the kind of value that drifts silently. It was
 * flipped ON only after a matched A/B (22,516 → 12,794 tokens prefilled across
 * two sibling sessions); these pin what that measurement bought.
 *
 * `systemSharedPrefix` is the observable: present ⇒ the adapter keys a
 * `prefix-band-` id and sends `stable_prefix_chars`; absent ⇒ byte-identical to
 * the pre-feature behaviour.
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
let mlxMock: MockProvider;
let llamaMock: MockProvider;

async function makeManager(): Promise<ChatManager> {
  return new ChatManager({
    store,
    events,
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    providers: [
      ['mlx', mlxMock],
      ['llama-cpp', llamaMock],
    ],
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-band-gate-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.createGezel({ name: 'Ada', role: 'Developer' });
  events = new ChatEventBus();
  mlxMock = new MockProvider({ name: 'mlx' });
  llamaMock = new MockProvider({ name: 'llama-cpp' });
});

afterEach(async () => {
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
    (c) => c.kind === 'create' && !!c.opts?.systemMessage.startsWith('Your role is'),
  )?.opts;
}

async function runOneTurn(provider: string, mock: MockProvider) {
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
    mock.script('ok');
    await manager.send(session.id, 'start');
    return findCreateOpts(mock);
  } finally {
    await manager.drainBackground();
    await manager.shutdown();
  }
}

describe('shared-band prefix cache — gating', () => {
  it('mlx defaults ON and the band is a byte-prefix of the system message', async () => {
    await store.writeConfig({ provider: 'mlx' });
    const opts = await runOneTurn('mlx', mlxMock);
    expect(opts?.systemSharedPrefix).toBeDefined();
    // The whole design rests on this: `sharedPrefix` is a literal leading run
    // of `full`, never a rewrite of it. If it stops being a prefix, the engine
    // seeds a cache that is not a token prefix and every sibling pays a full
    // re-prefill instead of a clean miss.
    expect(opts?.systemMessage.startsWith(opts!.systemSharedPrefix!)).toBe(true);
    expect(opts!.systemSharedPrefix!.length).toBeLessThan(opts!.systemMessage.length);
    // It must stop before the session-scoped tail — that is what siblings share.
    expect(opts?.systemSharedPrefix).not.toContain('### Current task');
    expect(opts?.systemMessage).toContain('### Current task');
  });

  it('explicit { enabled: false } opts out', async () => {
    await store.writeConfig({ provider: 'mlx', mlxSharedBandPrefix: { enabled: false } });
    const opts = await runOneTurn('mlx', mlxMock);
    expect(opts?.systemSharedPrefix).toBeUndefined();
  });

  it('never applies to other engines', async () => {
    // llama-cpp has its own prefix scheme and can trim, so it has neither the
    // problem nor the mechanism. Enabling it there would key a band id the
    // llama adapter never reads.
    await store.writeConfig({ provider: 'llama-cpp', mlxSharedBandPrefix: { enabled: true } });
    const opts = await runOneTurn('llama-cpp', llamaMock);
    expect(opts?.systemSharedPrefix).toBeUndefined();
  });
});
