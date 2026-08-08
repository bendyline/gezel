import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import type { MemoryManager } from '../memory/manager.js';
import { CopilotProvider } from '../providers/copilot.js';
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

function copilotSdkWithObservedBuiltin(): Record<string, unknown> {
  type Event = { data: Record<string, unknown> };
  type Handler = (event: Event) => void;
  const listeners = new Map<string, Set<Handler>>();
  const emit = (name: string, data: Record<string, unknown>) => {
    for (const listener of listeners.get(name) ?? []) listener({ data });
  };
  const session = {
    sessionId: 'copilot-history-test',
    on(name: string, handler: Handler) {
      const group = listeners.get(name) ?? new Set<Handler>();
      group.add(handler);
      listeners.set(name, group);
      return () => group.delete(handler);
    },
    async sendAndWait() {
      emit('tool.execution_start', {
        toolCallId: 'tool-1',
        toolName: 'bash',
        arguments: { command: 'printf observed' },
      });
      emit('tool.execution_complete', {
        toolCallId: 'tool-1',
        success: true,
      });
      return { data: { content: 'Observed completion.' } };
    },
    async disconnect() {},
  };
  return {
    approveAll: () => ({ kind: 'approve-once' }),
    CopilotClient: class {
      async start() {}
      async stop() {}
      async createSession() {
        return session;
      }
      async resumeSession() {
        return session;
      }
      async listModels() {
        return [];
      }
      async getAuthStatus() {
        return { isAuthenticated: true };
      }
    },
  };
}

let home: string;
let store: Store;
let history: HistoryManager;
let provider: CopilotProvider;
let manager: ChatManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-copilot-history-'));
  history = new HistoryManager(home);
  store = new Store({ home, history });
  await store.ensureLayout();
  await store.ensureDefaultProject();
  await store.createGezel({ name: 'Ada', role: 'Developer' });
  await store.writeConfig({
    provider: 'copilot',
    sandboxCopilot: false,
    toolFilterMode: 'never',
  });

  provider = new CopilotProvider({});
  vi.spyOn(provider as unknown as { loadSdk: () => Promise<unknown> }, 'loadSdk').mockResolvedValue(
    copilotSdkWithObservedBuiltin(),
  );
  manager = new ChatManager({
    store,
    events: new ChatEventBus(),
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    providers: [['copilot', provider]],
    history,
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
  });
});

afterEach(async () => {
  await manager.drainBackground();
  await manager.shutdown().catch(() => {});
  await rm(home, { recursive: true, force: true });
});

describe('Copilot provider-native History visibility', () => {
  it('records an SDK-observed built-in completion even in compatibility mode', async () => {
    const session = await manager.createSession({ gezelId: 'ada' });
    let resolveObserved!: () => void;
    const observed = new Promise<void>((resolve) => {
      resolveObserved = resolve;
    });
    const unsubscribe = history.subscribe((event) => {
      if (event.kind === 'tool.called' && event.details?.name === 'bash') resolveObserved();
    });
    try {
      await manager.send(session.id, 'Run the observed command.');
      await observed;
    } finally {
      unsubscribe();
    }

    const events = await history.listEvents({
      projectId: 'default',
      kinds: ['tool.called'],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'tool.called',
      projectId: 'default',
      gezelId: 'ada',
      details: {
        name: 'bash',
        sessionId: session.id,
        argKeys: ['command'],
        success: true,
      },
    });
  });
});
