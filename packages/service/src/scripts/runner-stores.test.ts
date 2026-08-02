import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatEventBus } from '../chat/events.js';
import { ChatManager } from '../chat/manager.js';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ScriptRunner } from './runner.js';

const noopMemory = {
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

it('resolves the stores subpath export from the built SDK', async () => {
  // Guards the package.json exports + tsup entry wiring on every platform;
  // the sandbox run below only executes where denyNet has an OS boundary.
  const stores = await import('@bendyline/gezel-sdk/stores');
  expect(typeof stores.logStore).toBe('function');
  expect(typeof stores.rosterStore).toBe('function');
});

describe.runIf(process.platform === 'darwin')('ScriptRunner — SDK stores in the sandbox', () => {
  let home: string;
  let store: Store;
  let manager: ChatManager;
  let runner: ScriptRunner;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-runner-stores-'));
    store = new Store({ home });
    await store.ensureLayout();
    // This suite injects a mock under the 'copilot' key. Pin it as the default
    // too — otherwise routing falls through to the platform default (an
    // on-device engine) and the injected mock is never reached.
    await store.writeConfig({ provider: 'copilot' });
    await store.createProject({ name: 'Default' });
    manager = new ChatManager({
      store,
      events: new ChatEventBus(),
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home,
      providers: [['copilot', new MockProvider({ name: 'copilot' })]],
      catalog: new CatalogService(),
      secrets: new FileSecretStore(home),
    });
    runner = new ScriptRunner({ store, chat: manager });
  });

  afterEach(async () => {
    await manager.drainBackground();
    await manager.shutdown();
    await rm(home, { recursive: true, force: true });
  });

  it('runs a script that persists through logStore via the vendored subpath', async () => {
    const dir = join(home, 'projects', 'default', 'scripts');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'store-probe.ts'),
      `
          import { gezel, defineScript } from '@bendyline/gezel-sdk';
          import { logStore } from '@bendyline/gezel-sdk/stores';
          export const meta = defineScript({
            name: 'store-probe',
            description: 'appends a practice event and reports stats.',
            outputs: {
              total: { type: 'number', description: 'events recorded' },
              streak: { type: 'number', description: 'consecutive-day streak' },
            },
            requires: ['workspace.read', 'workspace.write'],
          });
          const log = logStore(gezel.fs, 'log.json');
          await log.append({ kind: 'practice', note: 'first session' });
          const stats = await log.stats();
          gezel.output({ total: stats.total, streak: stats.streakDays });
        `,
      'utf8',
    );

    const run = await runner.run({
      projectId: 'default',
      scriptName: 'store-probe',
      trigger: { kind: 'manual', userInitiated: true },
    });

    expect(run.status).toBe('ok');
    expect(run.output).toEqual({ total: 1, streak: 1 });

    const persisted = JSON.parse(
      await readFile(join(await store.projectWorkspaceDir('default'), 'log.json'), 'utf8'),
    );
    expect(persisted.version).toBe(1);
    expect(persisted.events).toHaveLength(1);
    expect(persisted.events[0]).toMatchObject({ kind: 'practice', note: 'first session' });
  }, 60_000);
});
