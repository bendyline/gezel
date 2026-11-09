import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type InstalledToolset, securityPolicyForLevel } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

/**
 * A hosted (http-mcp) toolset reaches every provider that can speak its
 * transport. Copilot used to drop hosted servers without a word; Codex was
 * handed SSE servers it cannot reach.
 */

const noopMemory = {
  save: async () => {},
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

const hostedToolset = (
  toolsetId: string,
  transport: 'streamable-http' | 'sse',
  url: string,
): InstalledToolset => ({
  toolsetId,
  sourceId: 'community',
  version: '1.0.0',
  installedAt: '2026-11-08T00:00:00Z',
  runtime: { kind: 'http-mcp', url, transport, authHint: 'none', envHints: [] },
});

let home: string | null = null;
let manager: ChatManager | null = null;

afterEach(async () => {
  await manager?.drainBackground();
  await manager?.shutdown();
  if (home) await rm(home, { recursive: true, force: true });
  manager = null;
  home = null;
});

async function extrasFor(
  providerName: 'copilot' | 'anthropic-cli' | 'codex-cli',
): Promise<Array<{ id: string; kind?: string; transport?: string }>> {
  home = await mkdtemp(join(tmpdir(), 'gezel-hosted-mcp-test-'));
  const store = new Store({ home });
  await store.ensureLayout();
  await store.writeConfig({ provider: providerName });
  await store.writeConfig({ securityPolicy: securityPolicyForLevel('free') });
  await store.createGezel({ name: 'Ada', role: 'Developer' });
  await store.writeInstalledToolsets({ kind: 'shared' }, [
    hostedToolset('com.example-current', 'streamable-http', 'http://127.0.0.1:9/mcp'),
    hostedToolset('com.example-legacy', 'sse', 'http://127.0.0.1:9/sse'),
  ]);
  const mock = new MockProvider({ name: 'copilot' });
  manager = new ChatManager({
    store,
    events: new ChatEventBus(),
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    providers: [[providerName, mock]],
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
  });
  const session = await manager.createSession({ gezelId: 'ada' });
  mock.script('done');
  await manager.send(session.id, 'hello');
  const create = mock.calls.filter((c) => c.kind === 'create').at(-1) as
    | { opts: { extraMcpServers?: Array<{ id: string; kind?: string; transport?: string }> } }
    | undefined;
  expect(create).toBeTruthy();
  return create?.opts.extraMcpServers ?? [];
}

describe('ChatManager — hosted MCP toolsets per provider', () => {
  for (const provider of ['copilot', 'anthropic-cli'] as const) {
    it(`${provider} gets both transports`, async () => {
      const extras = await extrasFor(provider);
      expect(extras.map((e) => [e.id, e.kind, e.transport])).toEqual([
        ['com.example-current', 'http', 'streamable-http'],
        ['com.example-legacy', 'http', 'sse'],
      ]);
    });
  }

  it('codex-cli gets Streamable HTTP only', async () => {
    const extras = await extrasFor('codex-cli');
    expect(extras.map((e) => e.id)).toEqual(['com.example-current']);
  });
});
