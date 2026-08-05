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

/**
 * The docblocks toolset spawn wiring: `docblocks mcp` starts with zero
 * filesystem authority, so ChatManager must grant the session's project
 * scope at spawn time — read on workspace + artifacts, write on artifacts
 * only. These tests assert the exact args handed to the MCP bridge; the
 * child itself never successfully starts (the installPath is a stub),
 * which the bridge tolerates by design.
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
let manager: ChatManager;
let mock: MockProvider;

const docblocksToolset = (installPath: string, args: string[] = ['mcp']): InstalledToolset => ({
  toolsetId: 'docblocks',
  sourceId: 'bundled',
  version: '2.3.4',
  installedAt: '2026-07-14T00:00:00Z',
  installPath,
  runtime: {
    kind: 'npm-package',
    package: '@bendyline/docblocks-cli',
    version: '2.3.4',
    sha256: 'f9ebde4f7ea370778c9becf2a4f7a15fd435b4f2bcfdbcdf0f4242a1ef2db674',
    entry: 'dist/bin.js',
    args,
    envHints: [],
  },
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-docblocks-test-'));
  store = new Store({ home });
  await store.ensureLayout();
  // This suite injects a mock under the 'copilot' key. Pin it as the default
  // too — otherwise routing falls through to the platform default (an
  // on-device engine) and the injected mock is never reached.
  await store.writeConfig({ provider: 'copilot' });
  await store.writeConfig({ securityPolicy: securityPolicyForLevel('free') });
  await store.createGezel({ name: 'Ada', role: 'Developer' });
  await store.createProject({ name: 'Default' });
  await mkdir(join(home, 'stub', 'dist'), { recursive: true });
  await writeFile(join(home, 'stub', 'dist', 'bin.js'), '#!/usr/bin/env node\n');
  events = new ChatEventBus();
  mock = new MockProvider({ name: 'copilot' });
  manager = new ChatManager({
    store,
    events,
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    providers: [['copilot', mock]],
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
  });
});

afterEach(async () => {
  await manager.drainBackground();
  await manager.shutdown();
  await rm(home, { recursive: true, force: true });
});

async function extraSpecsAfterSend(
  projectId?: string,
): Promise<Array<{ id: string; kind?: string; args?: string[] }>> {
  const session = await manager.createSession({
    gezelId: 'ada',
    ...(projectId ? { projectId } : {}),
  });
  mock.script('done');
  await manager.send(session.id, 'hello');
  const create = mock.calls.find((c) => c.kind === 'create');
  expect(create).toBeTruthy();
  return (create as { opts: { extraMcpServers?: Array<{ id: string; args?: string[] }> } }).opts
    .extraMcpServers as Array<{ id: string; kind?: string; args?: string[] }>;
}

describe('ChatManager — docblocks toolset spawn grants project roots', () => {
  it('keeps the exact bundled, root-confined runtime available under super-lockdown', async () => {
    await store.writeConfig({ securityPolicy: securityPolicyForLevel('super-lockdown') });
    await store.writeInstalledToolsets({ kind: 'shared' }, [docblocksToolset(join(home, 'stub'))]);

    const extras = await extraSpecsAfterSend();
    expect(extras.find((e) => e.id === 'docblocks')).toBeTruthy();
  });

  it('grants read on workspace + artifacts and write on artifacts only', async () => {
    // Make the workspace dir exist — only existing directories are granted
    // (docblocks physically validates roots at startup).
    await store.writeProjectWorkspaceFile('default', 'notes.md', '# hi\n');
    await store.writeInstalledToolsets({ kind: 'shared' }, [docblocksToolset(join(home, 'stub'))]);

    const extras = await extraSpecsAfterSend();
    const spec = extras.find((e) => e.id === 'docblocks');
    expect(spec).toBeTruthy();
    const args = spec?.args ?? [];

    expect(args[0]).toBe(join(home, 'stub', 'dist', 'bin.js'));
    expect(args[1]).toBe('mcp');

    const workspaceDir = await store.projectWorkspaceDir('default');
    const artifactsDir = store.projectArtifactsDir('default');
    const readIdx = args.indexOf('--allow-read');
    const writeIdx = args.indexOf('--allow-write');
    expect(readIdx).toBeGreaterThan(0);
    expect(writeIdx).toBeGreaterThan(readIdx);
    // Read roots: workspace + artifacts (between the two flags).
    expect(args.slice(readIdx + 1, writeIdx)).toEqual([workspaceDir, artifactsDir]);
    // Write root: artifacts only — never the workspace.
    expect(args.slice(writeIdx + 1)).toEqual([artifactsDir]);
  });

  it('skips a missing external workingDir but still grants the artifacts drawer', async () => {
    // An external workingDir is the user's folder — never created by gezel.
    // Pointing at a nonexistent path means the workspace root must NOT be
    // granted (docblocks would refuse the whole grant set at startup), while
    // the gezel-owned artifacts drawer is created on demand and granted.
    const gone = join(home, 'does-not-exist');
    const project = await store.createProject({ name: 'External', workingDir: gone });
    await store.writeInstalledToolsets({ kind: 'shared' }, [docblocksToolset(join(home, 'stub'))]);

    const extras = await extraSpecsAfterSend(project.id);
    const spec = extras.find((e) => e.id === 'docblocks');
    const args = spec?.args ?? [];

    const artifactsDir = store.projectArtifactsDir(project.id);
    const readIdx = args.indexOf('--allow-read');
    const writeIdx = args.indexOf('--allow-write');
    expect(writeIdx).toBeGreaterThan(0);
    expect(args.slice(writeIdx + 1)).toEqual([artifactsDir]);
    expect(args.slice(readIdx + 1, writeIdx)).toEqual([artifactsDir]);
    expect(args).not.toContain(gone);
  });

  it('does not re-grant roots when the installed args already carry them', async () => {
    await store.writeInstalledToolsets({ kind: 'shared' }, [
      docblocksToolset(join(home, 'stub'), ['mcp', '--allow-read', 'X', '--allow-write', 'Y']),
    ]);

    const extras = await extraSpecsAfterSend();
    const spec = extras.find((e) => e.id === 'docblocks');
    const args = spec?.args ?? [];
    expect(args.filter((a) => a === '--allow-read')).toHaveLength(1);
    expect(args.filter((a) => a === '--allow-write')).toHaveLength(1);
  });
});
