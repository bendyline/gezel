import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { securityPolicyForLevel } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { MACHINE_SHARED_MARKER } from '@bendyline/gezel/paths';
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

let root: string;
let previousSharedOverride: string | undefined;
let manager: ChatManager | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gezel-shared-mcp-'));
  previousSharedOverride = process.env.GEZEL_MACHINE_SHARED_HOME;
  delete process.env.GEZEL_MACHINE_SHARED_HOME;
});

afterEach(async () => {
  await manager?.drainBackground();
  await manager?.shutdown();
  manager = undefined;
  if (previousSharedOverride === undefined) delete process.env.GEZEL_MACHINE_SHARED_HOME;
  else process.env.GEZEL_MACHINE_SHARED_HOME = previousSharedOverride;
  await rm(root, { recursive: true, force: true });
});

describe('ChatManager — machine-shared project MCP trust', () => {
  it('does not execute MCP configuration merely because it exists in the shared workspace', async () => {
    const sharedHome = join(root, 'shared');
    const legacy = new Store({ home: sharedHome });
    await legacy.ensureLayout();
    const sharedProject = await legacy.createProject({ name: 'Shared Project' });
    const sharedWorkspace = await legacy.projectWorkspaceDir(sharedProject.id);
    await writeFile(
      join(sharedWorkspace, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          attacker: { command: 'node', args: ['other-account-controlled.js'] },
        },
      }),
    );
    await writeFile(join(sharedHome, MACHINE_SHARED_MARKER), `${JSON.stringify({ version: 1 })}\n`);
    process.env.GEZEL_MACHINE_SHARED_HOME = sharedHome;

    const userHome = join(root, 'user');
    const store = new Store({ home: userHome });
    await store.ensureLayout();
    await store.writeConfig({
      provider: 'copilot',
      securityPolicy: securityPolicyForLevel('free'),
    });
    const gezel = await store.createGezel({ name: 'Ada', role: 'Developer' });
    const mock = new MockProvider({ name: 'copilot' });
    manager = new ChatManager({
      store,
      events: new ChatEventBus(),
      memory: noopMemory,
      getPort: () => 0,
      getToken: () => 'test-token',
      home: userHome,
      providers: [['copilot', mock]],
      catalog: new CatalogService(),
      secrets: new FileSecretStore(userHome),
    });

    const session = await manager.createSession({
      gezelId: gezel.id,
      projectId: sharedProject.id,
    });
    mock.script('done');
    await manager.send(session.id, 'hello');

    const create = mock.calls.find((call) => call.kind === 'create') as
      | { opts: { extraMcpServers?: Array<{ id: string }> } }
      | undefined;
    expect(create?.opts.extraMcpServers ?? []).not.toContainEqual(
      expect.objectContaining({ id: expect.stringContaining('attacker') }),
    );
    expect(JSON.stringify(create?.opts.extraMcpServers ?? [])).not.toContain(
      'other-account-controlled.js',
    );
  });
});
