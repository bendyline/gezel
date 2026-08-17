import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatSession } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import type { MemoryManager } from '../memory/manager.js';
import type { LlamaCppModelManager } from '../providers/llama-cpp/index.js';
import { createRemotesRegistry } from '../remotes/registry.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

/**
 * A `config.defaultModel` pin can name weights that never landed — first-run
 * pins the hardware recommendation before the download, so an abandoned fetch
 * leaves the install pointing at a model no engine has. In a machine-service
 * install that id used to be forwarded verbatim to the broker, which answered
 * `model_not_loaded` on every turn, and the Settings picker that would repair it
 * stays hidden while only one model is installed. Sessions must reconcile the
 * pin against inventory instead.
 */

const noopMemory = {
  save: async () => {},
  search: async () => [],
  searchAll: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const GEMMA = {
  id: 'gemma4-e4b-q4',
  name: 'Gemma 4 (E4B, Q4)',
  approxSizeBytes: 4_275_373_792,
  installedAt: '2026-08-17T02:47:07.293Z',
  chatTemplatePresent: true,
};

/** A store holding exactly `installed`, mirroring the wild-caught inventory. */
function fakeModelStore(installed: Array<typeof GEMMA>) {
  const listInstalled = vi.fn(async () => installed);
  const resolveModel = vi.fn(async (id: string) => installed.find((m) => m.id === id) ?? null);
  return {
    listInstalled,
    resolveModel,
    store: { listInstalled, resolveModel } as unknown as LlamaCppModelManager,
  };
}

async function machineEngineManager(opts: {
  pinnedDefault?: string;
  installed: Array<typeof GEMMA>;
}) {
  const home = await mkdtemp(join(tmpdir(), 'gezel-default-model-'));
  const store = new Store({ home });
  await store.ensureLayout();
  await store.writeConfig({
    provider: 'llama-cpp',
    firstRunCompleted: true,
    ...(opts.pinnedDefault ? { defaultModel: { 'llama-cpp': opts.pinnedDefault } } : {}),
  });
  const remotes = await createRemotesRegistry({ home });
  remotes.setEphemeral({
    remoteId: 'this-machine',
    baseUrl: 'https://127.0.0.1:6228',
    displayName: 'This Linux device',
    token: 'machine-token',
    pinnedIdentityKey: 'test-key',
    pinnedIdentityFingerprint: 'test-fingerprint',
    scopes: ['remote-inference', 'machine-models'],
    pairedAt: Date.now(),
    managed: 'machine-engine',
  });
  const models = fakeModelStore(opts.installed);
  const manager = new ChatManager({
    store,
    events: new ChatEventBus(),
    memory: noopMemory,
    getPort: () => 0,
    getToken: () => 'test-token',
    home,
    llamaCppModels: models.store,
    catalog: new CatalogService(),
    secrets: new FileSecretStore(home),
  });
  manager.setRemotesRegistry(remotes);
  manager.setMachineEngineRemoteResolver(() => 'this-machine');
  cleanups.push(async () => {
    await manager.shutdown();
    await rm(home, { recursive: true, force: true });
  });
  return { manager, store, models };
}

function sessionRecord(model: string): ChatSession {
  return {
    version: 1,
    id: 'session-1',
    gezelId: 'bastien',
    projectId: 'default',
    providerName: 'llama-cpp',
    model,
    title: 'New thread',
    providerState: {},
    messages: [],
    createdAt: '2026-08-17T13:05:15.551Z',
    lastActivityAt: '2026-08-17T13:05:15.551Z',
  };
}

describe('ChatManager — a default model whose weights never landed', () => {
  it('serves the installed model instead of forwarding the dead pin to the broker', async () => {
    const { manager } = await machineEngineManager({
      pinnedDefault: 'qwen3.6-27b-q8',
      installed: [GEMMA],
    });

    const provider = await manager.ensureProviderForSession(sessionRecord('qwen3.6-27b-q8'));

    expect(provider.getEffectiveModelId?.()).toBe('llama-cpp:gemma4-e4b-q4');
  });

  it('repins the install default so Settings and the engine pill stop disagreeing', async () => {
    const { manager, store } = await machineEngineManager({
      pinnedDefault: 'qwen3.6-27b-q8',
      installed: [GEMMA],
    });

    await manager.ensureProviderForSession(sessionRecord('qwen3.6-27b-q8'));

    expect((await store.readConfig()).defaultModel?.['llama-cpp']).toBe('gemma4-e4b-q4');
  });

  it('repins once per dead id however many sessions hit it', async () => {
    const { manager, models } = await machineEngineManager({
      pinnedDefault: 'qwen3.6-27b-q8',
      installed: [GEMMA],
    });

    await manager.ensureProviderForSession(sessionRecord('qwen3.6-27b-q8'));
    await manager.ensureProviderForSession(sessionRecord('qwen3.6-27b-q8'));

    // The second build reads the repaired config, so it resolves a live model
    // and never reaches the inventory listing at all.
    expect(models.listInstalled).toHaveBeenCalledTimes(1);
  });

  it("substitutes for a dead gezel pin without rewriting the user's frontmatter choice", async () => {
    const { manager, store } = await machineEngineManager({
      pinnedDefault: 'gemma4-e4b-q4',
      installed: [GEMMA],
    });

    const provider = await manager.ensureProviderForSession(sessionRecord('gemma4-e4b-q4'), {
      parsed: { frontmatter: { model: 'qwen3.8-27b-q4' } },
    });

    expect(provider.getEffectiveModelId?.()).toBe('llama-cpp:gemma4-e4b-q4');
    expect((await store.readConfig()).defaultModel?.['llama-cpp']).toBe('gemma4-e4b-q4');
  });

  it('passes the pin through untouched when there is nothing better to offer', async () => {
    const { manager, store } = await machineEngineManager({
      pinnedDefault: 'qwen3.6-27b-q8',
      installed: [],
    });

    // Nothing installed is the fresh-install state the download banner owns.
    // Substituting is impossible and rewriting the pin would erase the
    // recommendation the banner is waiting to fetch.
    const provider = await manager.ensureProviderForSession(sessionRecord('qwen3.6-27b-q8'));

    expect(provider.getEffectiveModelId?.()).toBe('llama-cpp:qwen3.6-27b-q8');
    expect((await store.readConfig()).defaultModel?.['llama-cpp']).toBe('qwen3.6-27b-q8');
  });

  it('leaves a live pin alone without listing the inventory', async () => {
    const { manager, models } = await machineEngineManager({
      pinnedDefault: 'gemma4-e4b-q4',
      installed: [GEMMA],
    });

    const provider = await manager.ensureProviderForSession(sessionRecord('gemma4-e4b-q4'));

    expect(provider.getEffectiveModelId?.()).toBe('llama-cpp:gemma4-e4b-q4');
    expect(models.listInstalled).not.toHaveBeenCalled();
  });
});

describe('ChatManager.getProviderForModel — /v1 callers', () => {
  it('rejects an explicitly named missing model rather than silently swapping it', async () => {
    const { manager } = await machineEngineManager({
      pinnedDefault: 'gemma4-e4b-q4',
      installed: [GEMMA],
    });

    await expect(manager.getProviderForModel('llama-cpp', 'qwen3.6-27b-q8')).rejects.toThrow(
      /not available locally/i,
    );
  });

  it('reconciles the config default it falls back to', async () => {
    const { manager } = await machineEngineManager({
      pinnedDefault: 'qwen3.6-27b-q8',
      installed: [GEMMA],
    });

    const provider = await manager.getProviderForModel('llama-cpp');

    expect(provider.getEffectiveModelId?.()).toBe('llama-cpp:gemma4-e4b-q4');
  });
});
