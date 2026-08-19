import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type InstalledToolset, securityPolicyForLevel } from '@bendyline/gezel';
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

let home: string;
let store: Store;
let manager: ChatManager;
let mock: MockProvider;

function playwrightToolset(installPath: string): InstalledToolset {
  return {
    toolsetId: '@playwright/mcp',
    sourceId: 'system',
    version: '0.0.78',
    installedAt: '2026-08-06T00:00:00Z',
    installPath,
    runtime: {
      kind: 'npm-package',
      package: '@playwright/mcp',
      version: '0.0.78',
      sha256: '0'.repeat(64),
      entry: 'cli.js',
      args: [],
      envHints: [],
    },
  };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-local-preview-browser-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.writeConfig({
    provider: 'llama-cpp',
    securityPolicy: securityPolicyForLevel('super-lockdown'),
  });
  await store.createGezel({ name: 'Ada', role: 'Web Developer' });
  await store.createProject({ name: 'Default' });
  const installPath = join(home, 'playwright-stub');
  await mkdir(installPath, { recursive: true });
  await writeFile(join(installPath, 'cli.js'), '#!/usr/bin/env node\n');
  await store.writeInstalledToolsets({ kind: 'system' }, [playwrightToolset(installPath)]);

  mock = new MockProvider({ name: 'llama-cpp' });
  manager = new ChatManager({
    store,
    events: new ChatEventBus(),
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    getWorkspacePreviewOrigin: () => 'http://127.0.0.1:41234',
    createWorkspacePreviewUrl: async (projectId, path) =>
      `http://127.0.0.1:41234/preview/${'A'.repeat(43)}/workspace/${projectId}/${path}`,
    home,
    providers: [['llama-cpp', mock]],
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
  });
});

afterEach(async () => {
  await manager.drainBackground();
  await manager.shutdown();
  await rm(home, { recursive: true, force: true });
});

interface CapturedCreateOpts {
  extraMcpServers?: Array<{ id: string; args?: string[] }>;
  workspacePreview?: { origin?: string; localOnly?: boolean };
  systemMessage: string;
}

async function latestCreateOpts(): Promise<CapturedCreateOpts> {
  const session = await manager.createSession({ gezelId: 'ada', projectId: 'default' });
  mock.script('done');
  await manager.send(session.id, 'hello');
  const create = mock.calls.filter((call) => call.kind === 'create').at(-1);
  expect(create).toBeTruthy();
  return (create as { opts: CapturedCreateOpts }).opts;
}

describe('ChatManager — local-preview browser security exception', () => {
  it('admits only the managed system Playwright with the local proxy boundary', async () => {
    const opts = await latestCreateOpts();
    const playwright = opts.extraMcpServers?.find((entry) => entry.id.includes('playwright'));
    expect(playwright).toBeTruthy();
    expect(playwright?.args).toEqual(
      expect.arrayContaining([
        '--output-dir',
        join(store.projectArtifactsDir('default'), 'screenshots'),
        '--proxy-server',
        'http://127.0.0.1:41234',
        '--proxy-bypass',
        '<-loopback>',
        '--allowed-origins',
        'http://127.0.0.1:41234',
        '--block-service-workers',
      ]),
    );
    expect(opts.workspacePreview).toMatchObject({
      origin: 'http://127.0.0.1:41234',
      localOnly: true,
    });
    expect(opts.systemMessage).toContain('Local preview browser');
    expect(opts.systemMessage).toContain(
      'External URLs and arbitrary localhost services are blocked',
    );
  });

  it.each(['separate value', 'equals value'])(
    'forces the project screenshots directory over a %s runtime arg',
    async (spelling) => {
      const escaped = join(home, 'escaped');
      const args =
        spelling === 'separate value' ? ['--output-dir', escaped] : [`--output-dir=${escaped}`];
      const installed = (await store.listInstalledToolsets({ kind: 'system' }))[0];
      if (!installed || installed.runtime.kind !== 'npm-package') {
        throw new Error('expected the system Playwright npm toolset');
      }
      await store.writeInstalledToolsets({ kind: 'system' }, [
        {
          ...installed,
          runtime: { ...installed.runtime, args },
        },
      ]);

      const opts = await latestCreateOpts();
      const playwright = opts.extraMcpServers?.find((entry) => entry.id.includes('playwright'));
      const outputOptionIndexes =
        playwright?.args
          ?.map((arg, index) =>
            arg === '--output-dir' || arg.startsWith('--output-dir=') ? index : -1,
          )
          .filter((index) => index >= 0) ?? [];
      expect(outputOptionIndexes).toHaveLength(1);
      const outputOptionIndex = outputOptionIndexes[0]!;
      expect(playwright?.args?.[outputOptionIndex]).toBe('--output-dir');
      expect(playwright?.args?.[outputOptionIndex + 1]).toBe(
        join(store.projectArtifactsDir('default'), 'screenshots'),
      );
      expect(playwright?.args?.join('\n')).not.toContain(escaped);
    },
  );

  it('does not extend the strict-mode exception to a user-installed copy', async () => {
    const installed = (await store.listInstalledToolsets({ kind: 'system' }))[0];
    expect(installed).toBeTruthy();
    await store.writeInstalledToolsets({ kind: 'gezel', gezelId: 'ada' }, [installed!]);

    const opts = await latestCreateOpts();
    expect(opts.extraMcpServers ?? []).not.toContainEqual(
      expect.objectContaining({ id: '@playwright/mcp' }),
    );
  });
});
