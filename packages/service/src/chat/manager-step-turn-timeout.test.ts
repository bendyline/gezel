/**
 * A task step's `turnTimeoutSec` reaches the provider as each turn's time
 * limit, retries included, and wins over the provider's default. Sessions
 * outside a task keep the default.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { TaskManager } from '../tasks/manager.js';
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

let home: string;
let mock: MockProvider;
let manager: ChatManager;
let tasks: TaskManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-step-turn-timeout-'));
  const history = new HistoryManager(home);
  const store = new Store({ home, history });
  await store.ensureLayout();
  await store.createProject({ name: 'p1' });
  await store.createGezel({ name: 'Worker' });
  await store.writeConfig({ provider: 'openai' });
  mock = new MockProvider({ name: 'openai' });
  manager = new ChatManager({
    store,
    events: new ChatEventBus(),
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    providers: [['openai', mock]],
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
    history,
  });
  tasks = new TaskManager(store, history);
});

afterEach(async () => {
  await manager.drainBackground();
  await manager.shutdown().catch(() => {});
  await rm(home, { recursive: true, force: true });
});

async function turnLimits(turnTimeoutSec?: number): Promise<Array<number | undefined>> {
  const task = await tasks.create('p1', {
    title: 'Review one image',
    assignee: { kind: 'gezel', gezelId: 'worker' },
    steps: [
      {
        id: 'review',
        name: 'Review',
        prompt: 'Review the image.',
        ...(turnTimeoutSec ? { turnTimeoutSec } : {}),
      },
    ],
    createdBy: { kind: 'user' },
  });
  mock.scriptSendFailure('[mock] turn timed out');
  mock.script('Reviewed.');
  await manager.startHandoffSession({
    gezelId: 'worker',
    projectId: 'p1',
    taskRef: task.ref,
    stepId: 'review',
    kind: 'entry',
  });
  await manager.drainBackground();
  // The failed turn and its retry; later sends are background one-shots.
  return mock.calls
    .flatMap((call) => (call.kind === 'send' ? [call.sendOpts?.timeoutMs] : []))
    .slice(0, 2);
}

it("uses the step's turnTimeoutSec for every turn, retries included", async () => {
  expect(await turnLimits(180)).toEqual([180_000, 180_000]);
});

it("keeps the provider's default when the step sets none", async () => {
  expect(await turnLimits()).toEqual([2 * 60 * 60 * 1000, 2 * 60 * 60 * 1000]);
});
