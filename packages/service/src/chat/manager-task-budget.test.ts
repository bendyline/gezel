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

const noopMemory = {
  save: async () => {},
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

// A tiny hard budget for every tier so a handful of autonomous turns trips it;
// soft off so the assertion is unambiguous. hardTurns:5 sits comfortably above
// any single clean send's turn count (so a user send never trips) while a few
// autonomous sends cross it.
const TIGHT_BUDGET = {
  softNudge: false,
  hardPause: true,
  limits: {
    tiny: { hardTurns: 5 },
    small: { hardTurns: 5 },
    medium: { hardTurns: 5 },
    large: { hardTurns: 5 },
    cloud: { hardTurns: 5 },
  },
} as const;

let home: string;
let store: Store;
let events: ChatEventBus;
let manager: ChatManager;
let mock: MockProvider;
let paused: Array<{ taskRef: string }>;

const now = new Date('2026-07-08T00:00:00Z').toISOString();

async function seedActiveTask(): Promise<void> {
  await store.writeTask({
    projectId: 'shop',
    num: 1,
    ref: 'shop/1',
    title: 'Build it',
    status: 'active',
    assignee: { kind: 'gezel', gezelId: 'dev' },
    craftbook: {
      id: 'cb-1',
      name: 'cb',
      steps: [{ id: 'p1', name: 'do it', createdAt: now }],
      entryStepId: 'p1',
      createdAt: now,
      updatedAt: now,
    },
    activeStepId: 'p1',
    createdAt: now,
    updatedAt: now,
    createdBy: { kind: 'user' },
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-taskbudget-'));
  store = new Store({ home });
  await store.ensureLayout();
  mock = new MockProvider({ name: 'openai' });
  await store.writeConfig({ provider: 'openai', taskBudget: TIGHT_BUDGET });
  await store.createGezel({ name: 'Dev', role: 'Developer' });
  await store.createProject({ name: 'Shop' });
  await seedActiveTask();
  events = new ChatEventBus();
  manager = new ChatManager({
    store,
    events,
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    providers: [['openai', mock]],
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
  });
  paused = [];
  manager.setTaskBudgetHandler((taskRef) => {
    paused.push({ taskRef });
  });
  // Let the constructor's async readConfig() land the tight budget before we drive turns.
  await new Promise((r) => setImmediate(r));
});

afterEach(async () => {
  await manager.shutdown();
  await rm(home, { recursive: true, force: true });
});

describe('ChatManager — fail-fast per-task budget (F3.1)', () => {
  it('pauses a task-scoped session once sustained AUTONOMOUS spend crosses the hard budget', async () => {
    const session = await manager.createSession({
      gezelId: 'dev',
      projectId: 'shop',
      taskRef: 'shop/1',
    });
    // Autonomous sends carry `from` (a handoff-style origin) → no reset, so the
    // per-task accumulator climbs across them toward the hard cap.
    const from = { gezelId: 'leo', gezelName: 'Leo' };
    for (let i = 0; i < 8 && paused.length === 0; i++) {
      mock.script('Working on it.');
      await manager.send(session.id, 'continue', { from });
    }
    // The manager's contract is to ROUTE a hard trip to the injected handler
    // with the right task ref; the handler's ACTION (note + setStatus('paused'))
    // is wired in service.ts and covered by its own path.
    expect(paused.length).toBeGreaterThanOrEqual(1);
    expect(paused[0]?.taskRef).toBe('shop/1');
  });

  it('never trips on user-initiated sends — each resets the accumulator', async () => {
    const session = await manager.createSession({
      gezelId: 'dev',
      projectId: 'shop',
      taskRef: 'shop/1',
    });
    // User sends carry NO `from` → each resets the accumulator, so a long
    // interactive conversation stays well under the cap.
    for (let i = 0; i < 10; i++) {
      mock.script('Here is the status.');
      await manager.send(session.id, 'status?');
    }
    expect(paused).toHaveLength(0);
  });
});
