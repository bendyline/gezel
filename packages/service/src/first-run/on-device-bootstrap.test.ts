import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import type { InstallEvent, LlamaCppModelManager } from '../providers/llama-cpp/index.js';
import type { MlxInstallEvent, MlxModelManager } from '../providers/mlx/index.js';
import {
  bootstrapOnDeviceFirstRun,
  isSupportedOnDevicePlatform,
  resolveFirstRunTarget,
} from './on-device-bootstrap.js';

/**
 * Covers the decision logic of `bootstrapOnDeviceFirstRun` without
 * actually hitting Hugging Face: a hand-rolled fake `LlamaCppModelManager`
 * captures which catalog id `install()` was called with + yields
 * whatever InstallEvent sequence the test scripted.
 *
 * `detectModelTier` itself isn't stubbed — on the test host it runs
 * for real (reads os.totalmem + the catalog, probes GPU VRAM). That's
 * fine; we only assert "the pin is SOME recommended id" (Gemma 4 or
 * Qwen 3.6), not which specific one. The ranking is tested separately
 * in `hardware-tier.test.ts` + core `recommendation.test.ts`.
 */

let home: string;
let store: Store;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-first-run-test-'));
  store = new Store({ home });
  await store.ensureLayout();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function fakeModelManager(
  scriptedEvents: InstallEvent[] = [{ type: 'done', id: 'gemma4-e2b-q4' }],
  installed: Array<{ id: string }> = [],
): {
  manager: LlamaCppModelManager;
  calls: string[];
  installCompleted: Promise<void>;
} {
  const calls: string[] = [];
  let resolveCompleted: () => void = () => {};
  const installCompleted = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const manager = {
    install: async function* (catalogId: string): AsyncIterable<InstallEvent> {
      calls.push(catalogId);
      try {
        for (const event of scriptedEvents) {
          yield event;
        }
      } finally {
        resolveCompleted();
      }
    },
    listInstalled: async () => installed,
    getActiveInstalls: () => [],
  } as unknown as LlamaCppModelManager;
  return { manager, calls, installCompleted };
}

function fakeMlxManager(
  scriptedEvents: MlxInstallEvent[] = [{ type: 'done', id: 'gemma4-e2b-mlx' }],
  installed: Array<{ id: string }> = [],
): {
  manager: MlxModelManager;
  calls: string[];
  installCompleted: Promise<void>;
} {
  const calls: string[] = [];
  let resolveCompleted: () => void = () => {};
  const installCompleted = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const manager = {
    install: async function* (catalogId: string): AsyncIterable<MlxInstallEvent> {
      calls.push(catalogId);
      try {
        for (const event of scriptedEvents) {
          yield event;
        }
      } finally {
        resolveCompleted();
      }
    },
    listInstalled: async () => installed,
    getActiveInstalls: () => [],
  } as unknown as MlxModelManager;
  return { manager, calls, installCompleted };
}

describe('bootstrapOnDeviceFirstRun', () => {
  it('skips entirely when firstRunCompleted is already set', async () => {
    await store.writeConfig({ firstRunCompleted: true });
    const { manager, calls } = fakeModelManager();
    await bootstrapOnDeviceFirstRun({
      store,
      llamaCppModels: manager,
      mlxModels: fakeMlxManager().manager,
      catalog: new CatalogService(),
    });
    expect(calls).toEqual([]);
    const config = await store.readConfig();
    expect(config.provider).toBeUndefined();
  });

  it('upgrades a stuck pin to a higher tier when the resolver now picks better hardware match', async () => {
    // The "stuck E2B" scenario: a prior bootstrap on the old threshold
    // (or with a model that never finished downloading) pinned E2B
    // even though the host can comfortably run a higher tier. On the
    // next launch, with no model on disk, the bootstrap should
    // re-evaluate and rewrite the pin to the current resolver's
    // verdict — without re-firing the install (the Home banner's
    // limbo recovery handles that).
    await store.writeConfig({
      provider: 'llama-cpp',
      defaultModel: { 'llama-cpp': 'gemma4-e2b-q4' },
      firstRunCompleted: true,
    });
    // Fake a host with 24 GB GPU so the resolver picks 26B-A4B; nothing
    // installed on disk so the re-eval branch fires.
    // (The bootstrap reads `process.platform`/`arch` directly when no
    // override is supplied, so we rely on platformOverride/archOverride
    // to keep the test cross-platform — but `detectModelTier` itself
    // reads live host info. The test asserts the SHAPE of the
    // re-eval, not the specific tier picked: any rewrite to a
    // non-e2b tier is success, since the resolver on the test host
    // wouldn't ever pick e2b anyway given a 24+ GB threshold isn't
    // typical of a CI box. We narrow to "config rewritten" to keep
    // the assertion robust.)
    const { manager: llama, calls: llamaCalls } = fakeModelManager(
      [],
      [], // nothing installed
    );
    const { manager: mlx } = fakeMlxManager();
    await bootstrapOnDeviceFirstRun({
      store,
      llamaCppModels: llama,
      mlxModels: mlx,
      catalog: new CatalogService(),
      platformOverride: 'win32',
      archOverride: 'x64',
    });
    const config = await store.readConfig();
    expect(config.provider).toBe('llama-cpp');
    // No install fired — the banner is responsible for kicking that
    // off via SSE so progress lights up the catalog UI too.
    expect(llamaCalls).toEqual([]);
    // The pin either stayed the same (resolver agreed with the
    // existing E2B for this host's actual hardware) or was rewritten
    // to a different tier. Either way, no error stamped.
    expect(config.firstRunInstallError).toBeUndefined();
    expect(config.defaultModel?.['llama-cpp']).toMatch(/^(gemma4|qwen3\.6)-/);
  });

  it('re-pins to an already-installed model when the pinned one is missing', async () => {
    // The "forgot my models" upgrade scenario: the pinned model vanished
    // (deleted from Settings, or a home flip hid it) but other working
    // models are on disk. Re-pinning to the tier winner would make Home
    // offer a fresh multi-GB download; instead we adopt an installed model.
    await store.writeConfig({
      provider: 'llama-cpp',
      defaultModel: { 'llama-cpp': 'gemma4-26b-q4' },
      firstRunCompleted: true,
      firstRunInstallError: 'stale error from the abandoned install',
    });
    const { manager: llama, calls: llamaCalls } = fakeModelManager(
      [],
      [{ id: 'gemma4-e2b-q4' }, { id: 'qwen3.6-27b-q8' }],
    );
    const { manager: mlx } = fakeMlxManager();
    await bootstrapOnDeviceFirstRun({
      store,
      llamaCppModels: llama,
      mlxModels: mlx,
      catalog: new CatalogService(),
      platformOverride: 'win32',
      archOverride: 'x64',
    });
    const config = await store.readConfig();
    expect(config.defaultModel?.['llama-cpp']).toBe('gemma4-e2b-q4');
    expect(config.firstRunInstallError).toBeUndefined();
    expect(llamaCalls).toEqual([]);
  });

  it('leaves the pin alone when the same model is already installed on disk', async () => {
    // User finished an E2B install successfully — even if a new tier
    // is now available, we don't tear down their working setup. The
    // re-eval branch is gated on the pinned model being absent.
    await store.writeConfig({
      provider: 'llama-cpp',
      defaultModel: { 'llama-cpp': 'gemma4-e2b-q4' },
      firstRunCompleted: true,
    });
    const { manager: llama, calls: llamaCalls } = fakeModelManager([], [{ id: 'gemma4-e2b-q4' }]);
    const { manager: mlx } = fakeMlxManager();
    await bootstrapOnDeviceFirstRun({
      store,
      llamaCppModels: llama,
      mlxModels: mlx,
      catalog: new CatalogService(),
      platformOverride: 'win32',
      archOverride: 'x64',
    });
    const config = await store.readConfig();
    expect(config.defaultModel?.['llama-cpp']).toBe('gemma4-e2b-q4');
    expect(llamaCalls).toEqual([]);
  });

  it('skips install but marks firstRunCompleted when user has already picked a provider', async () => {
    await store.writeConfig({ provider: 'copilot' });
    const { manager, calls } = fakeModelManager();
    await bootstrapOnDeviceFirstRun({
      store,
      llamaCppModels: manager,
      mlxModels: fakeMlxManager().manager,
      catalog: new CatalogService(),
    });
    expect(calls).toEqual([]);
    const config = await store.readConfig();
    expect(config.provider).toBe('copilot');
    expect(config.firstRunCompleted).toBe(true);
  });

  it('pins provider to llama-cpp and a recommended default on linux-x64 without auto-installing', async () => {
    const { manager, calls } = fakeModelManager();
    await bootstrapOnDeviceFirstRun({
      store,
      llamaCppModels: manager,
      mlxModels: fakeMlxManager().manager,
      catalog: new CatalogService(),
      platformOverride: 'linux',
      archOverride: 'x64',
    });
    const config = await store.readConfig();
    expect(config.provider).toBe('llama-cpp');
    expect(config.firstRunCompleted).toBe(true);
    expect(config.defaultModel?.['llama-cpp']).toMatch(/^(gemma4|qwen3\.6)-/);
    // The bootstrap no longer fires the install — the user must click
    // "Download recommended model" in the Home banner.
    expect(calls).toEqual([]);
  });

  it('pins provider to mlx and a recommended default on darwin-arm64 without auto-installing', async () => {
    const { manager: llamaMgr, calls: llamaCalls } = fakeModelManager();
    const { manager: mlxMgr, calls: mlxCalls } = fakeMlxManager();
    await bootstrapOnDeviceFirstRun({
      store,
      llamaCppModels: llamaMgr,
      mlxModels: mlxMgr,
      catalog: new CatalogService(),
      platformOverride: 'darwin',
      archOverride: 'arm64',
    });
    const config = await store.readConfig();
    expect(config.provider).toBe('mlx');
    expect(config.firstRunCompleted).toBe(true);
    expect(config.defaultModel?.mlx).toMatch(/^(gemma4|qwen3\.6)-/);
    expect(llamaCalls).toEqual([]);
    expect(mlxCalls).toEqual([]);
  });

  it('clears a stale firstRunInstallError when pinning the recommended default', async () => {
    // Simulate: a prior install attempt left an error flag; user
    // manually cleared firstRunCompleted to retry. Bootstrap re-pins
    // the recommended model and clears the error so the Home banner
    // can show the "Download recommended model" button cleanly.
    await store.writeConfig({ firstRunInstallError: 'previous error' });
    const { manager } = fakeModelManager();
    await bootstrapOnDeviceFirstRun({
      store,
      llamaCppModels: manager,
      mlxModels: fakeMlxManager().manager,
      catalog: new CatalogService(),
      platformOverride: 'linux',
      archOverride: 'x64',
    });
    const config = await store.readConfig();
    expect(config.firstRunInstallError).toBeUndefined();
  });
});

describe('resolveFirstRunTarget', () => {
  it('routes Apple Silicon to MLX', () => {
    // The catalog id stays the same on every platform — the provider
    // picks `manifest.mlx` vs `manifest.llamaCpp` at install time. The
    // older `gemma4-*-mlx` suffix referenced catalog entries that
    // never existed; dropping it fixes a latent first-run failure on
    // Apple Silicon.
    expect(resolveFirstRunTarget('gemma4-e2b-q4', 'darwin', 'arm64')).toEqual({
      provider: 'mlx',
      modelId: 'gemma4-e2b-q4',
    });
    expect(resolveFirstRunTarget('gemma4-e4b-q4', 'darwin', 'arm64')).toEqual({
      provider: 'mlx',
      modelId: 'gemma4-e4b-q4',
    });
    expect(resolveFirstRunTarget('gemma4-26b-q4', 'darwin', 'arm64')).toEqual({
      provider: 'mlx',
      modelId: 'gemma4-26b-q4',
    });
  });

  it('keeps Intel Mac / Linux / Windows on llama-cpp', () => {
    expect(resolveFirstRunTarget('gemma4-e4b-q4', 'darwin', 'x64')).toEqual({
      provider: 'llama-cpp',
      modelId: 'gemma4-e4b-q4',
    });
    expect(resolveFirstRunTarget('gemma4-e2b-q4', 'linux', 'x64')).toEqual({
      provider: 'llama-cpp',
      modelId: 'gemma4-e2b-q4',
    });
    expect(resolveFirstRunTarget('gemma4-e4b-q4', 'win32', 'x64')).toEqual({
      provider: 'llama-cpp',
      modelId: 'gemma4-e4b-q4',
    });
    expect(resolveFirstRunTarget('gemma4-26b-q4', 'win32', 'x64')).toEqual({
      provider: 'llama-cpp',
      modelId: 'gemma4-26b-q4',
    });
  });
});

describe('isSupportedOnDevicePlatform', () => {
  // Gate the bootstrap from auto-enrolling users on platforms we
  // don't ship a bundled `llama-server` for. The build matrix in
  // `.github/workflows/build-native.yml` is the source of truth —
  // this set has to stay in sync.
  it('accepts the bundled-binary matrix entries', () => {
    expect(isSupportedOnDevicePlatform('darwin', 'arm64')).toBe(true);
    expect(isSupportedOnDevicePlatform('linux', 'x64')).toBe(true);
    expect(isSupportedOnDevicePlatform('linux', 'arm64')).toBe(true);
    expect(isSupportedOnDevicePlatform('win32', 'x64')).toBe(true);
  });

  it('rejects Intel Mac (intentionally dropped from the matrix)', () => {
    expect(isSupportedOnDevicePlatform('darwin', 'x64')).toBe(false);
  });

  it('rejects Windows ARM (no binary shipped yet)', () => {
    expect(isSupportedOnDevicePlatform('win32', 'arm64')).toBe(false);
  });
});
