import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_DOWNLOAD_ENV,
  type AutoDownloadClient,
  autoDownloadRequested,
  downloadForRun,
} from './auto-download.js';
import type { BootstrapChatModel } from './tui/bootstrap.js';

interface FakeState {
  provider: string;
  defaultModel?: Record<string, string>;
  installed: string[];
  engineInstalled: boolean;
  freeBytes?: number;
}

function fakeClient(state: FakeState) {
  return {
    getConfig: vi.fn(async () => ({
      provider: state.provider,
      firstRunCompleted: true,
      ...(state.defaultModel ? { defaultModel: state.defaultModel } : {}),
    })),
    getGezel: vi.fn(async () => ({ parsed: { frontmatter: {} } })),
    getNativeEngineStatus: vi.fn(async () => ({
      pinned: true,
      platformKey: 'linux-x64',
      release: '0.1.62',
      llamaBackend: 'vulkan',
      engines: [{ name: 'llama-server', installed: state.engineInstalled }],
    })),
    ensureNativeEngine: vi.fn(async (_engine: string, onEvent: (event: unknown) => void) => {
      state.engineInstalled = true;
      onEvent({ type: 'done' });
    }),
    listLlamaCppModels: vi.fn(async () => ({ models: state.installed.map((id) => ({ id })) })),
    listMlxModels: vi.fn(async () => ({ models: [] })),
    getMemoryProfile: vi.fn(),
    listCatalogItems: vi.fn(),
    checkModelDownloadSpace: vi.fn(async ({ sizeBytes }: { sizeBytes: number }) => ({
      known: true,
      ok: (state.freeBytes ?? Number.MAX_SAFE_INTEGER) >= sizeBytes,
      freeBytes: state.freeBytes ?? 0,
      requiredBytes: sizeBytes,
    })),
    installLlamaCppModel: vi.fn(async (id: string, onEvent: (event: unknown) => void) => {
      state.installed.push(id);
      onEvent({ type: 'done' });
    }),
    installMlxModel: vi.fn(),
    installDs4Model: vi.fn(),
    getMlxRuntimeStatus: vi.fn(async () => ({ phase: 'ready' })),
    updateConfig: vi.fn(async (patch: Record<string, unknown>) => {
      if (patch.defaultModel) state.defaultModel = patch.defaultModel as Record<string, string>;
      return {};
    }),
  };
}

const asClient = (client: ReturnType<typeof fakeClient>) => client as unknown as AutoDownloadClient;

const GEMMA: BootstrapChatModel = {
  id: 'gemma4-e4b-q4',
  name: 'Gemma 4 E4B',
  provider: 'llama-cpp',
  approxSizeBytes: 4_100_000_000,
  residentBytes: 5_000_000_000,
  recoScore: 1,
  fit: 'fits',
  attribution: 'Google',
};

describe('autoDownloadRequested', () => {
  it('is on for the flag or the environment switch', () => {
    expect(autoDownloadRequested({ download: true }, {})).toBe(true);
    expect(autoDownloadRequested({}, { [AUTO_DOWNLOAD_ENV]: '1' })).toBe(true);
    expect(autoDownloadRequested({}, {})).toBe(false);
  });
});

describe('downloadForRun', () => {
  it('installs the engine, then the recommended model, and makes it the default', async () => {
    const state: FakeState = { provider: 'llama-cpp', installed: [], engineInstalled: false };
    const client = fakeClient(state);
    const written: string[] = [];
    await downloadForRun(asClient(client), {
      write: (text) => written.push(text),
      recommend: async () => GEMMA,
    });
    expect(client.ensureNativeEngine).toHaveBeenCalledOnce();
    expect(state.installed).toEqual(['gemma4-e4b-q4']);
    expect(state.defaultModel).toEqual({ 'llama-cpp': 'gemma4-e4b-q4' });
    const log = written.join('');
    expect(log).toContain(
      'Downloading Gemma 4 E4B (4.10 GB), the model recommended for this computer.',
    );
    expect(log).toContain('Ready.');
  });

  it('downloads the model this computer is set to use when it is missing', async () => {
    const state: FakeState = {
      provider: 'llama-cpp',
      defaultModel: { 'llama-cpp': 'qwen3.8-27b-q4' },
      installed: [],
      engineInstalled: true,
    };
    const client = fakeClient(state);
    await downloadForRun(asClient(client), { write: () => {}, recommend: async () => GEMMA });
    expect(state.installed).toEqual(['qwen3.8-27b-q4']);
  });

  it('does nothing for a cloud provider or a model that is already there', async () => {
    for (const state of [
      { provider: 'anthropic', installed: [], engineInstalled: false },
      { provider: 'llama-cpp', installed: ['gemma4-e4b-q4'], engineInstalled: true },
    ]) {
      const client = fakeClient(state);
      await downloadForRun(asClient(client), { write: () => {}, recommend: async () => GEMMA });
      expect(client.installLlamaCppModel).not.toHaveBeenCalled();
    }
  });

  it('stops before downloading when model storage is too full', async () => {
    const state: FakeState = {
      provider: 'llama-cpp',
      installed: [],
      engineInstalled: true,
      freeBytes: 1_000_000_000,
    };
    const client = fakeClient(state);
    const error = await downloadForRun(asClient(client), {
      write: () => {},
      recommend: async () => GEMMA,
    }).catch((e: Error) => e);
    expect((error as Error).message).toContain('Free some space');
    expect(client.installLlamaCppModel).not.toHaveBeenCalled();
  });
});
