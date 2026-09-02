/**
 * The store distribution profile, enforced at the seams that acquire code.
 *
 * A store build may not download or install executable code (App Store
 * guideline 2.4.5(iv) and the Microsoft Store equivalent), so each of these
 * paths must refuse with a sentence the user or model can act on — and each
 * must stay fully open in an ordinary build, which is the far more important
 * half of every assertion here.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveEngine } from './engines/resolver.js';
import { createOllamaEmulationController } from './http/ollama-emulation.js';
import { UvRuntime } from './python/uv-runtime.js';
import { SystemToolsetInstallRegistry } from './system-toolsets/install-registry.js';
import type { PinnedSystemToolset } from './system-toolsets/manifest.js';

const saved = process.env.GEZEL_DISTRIBUTION_PROFILE;

function asStoreBuild(): void {
  process.env.GEZEL_DISTRIBUTION_PROFILE = 'store';
}

afterEach(() => {
  if (saved === undefined) delete process.env.GEZEL_DISTRIBUTION_PROFILE;
  else process.env.GEZEL_DISTRIBUTION_PROFILE = saved;
});

describe('system toolset installs', () => {
  let home: string;
  const entry: PinnedSystemToolset = {
    toolsetId: '@github/copilot-sdk',
    version: '1.0.7',
    kind: 'library',
    onDemand: true,
  } as PinnedSystemToolset;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-dist-toolset-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true }).catch(() => {});
  });

  it('refuses before any install work starts, naming the constraint', () => {
    asStoreBuild();
    const registry = new SystemToolsetInstallRegistry({
      home,
      installImpl: () => {
        throw new Error('installer must never be reached in a store build');
      },
    });

    expect(() => registry.ensure(entry)).toThrow(/cannot install/i);
    // No snapshot was created either: a refused install must not appear in
    // the Settings list as something that started and failed.
    expect(registry.list()).toHaveLength(0);
  });

  it('starts the install in an ordinary build', async () => {
    delete process.env.GEZEL_DISTRIBUTION_PROFILE;
    let reached!: () => void;
    // `ensure` claims its snapshot synchronously and drives the install on a
    // detached promise, so "did the installer run" is only answerable after a
    // turn of the loop.
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const registry = new SystemToolsetInstallRegistry({
      home,
      installImpl: async function* () {
        reached();
        yield { type: 'log', chunk: 'installing' } as never;
        return undefined as never;
      } as never,
    });

    expect(() => registry.ensure(entry)).not.toThrow();
    await expect(started).resolves.toBeUndefined();
  });
});

describe('engine binary downloads', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-dist-engine-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true }).catch(() => {});
  });

  it('refuses to fetch an engine, without reaching the network', async () => {
    asStoreBuild();
    const gen = resolveEngine({
      engine: 'llama-server',
      home,
      fetchImpl: () => {
        throw new Error('network must never be reached in a store build');
      },
    });

    // The generator yields its error event before throwing, which is what the
    // Settings download card renders.
    const events: string[] = [];
    await expect(
      (async () => {
        for await (const event of gen) {
          if (event.type === 'error') events.push(event.error);
        }
      })(),
    ).rejects.toThrow(/runs only the engines it ships with/i);
    expect(events.join(' ')).toMatch(/runs only the engines it ships with/i);
  });
});

describe('Python provisioning', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-dist-python-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true }).catch(() => {});
  });

  it('refuses to provision a venv, actionably', async () => {
    asStoreBuild();
    const runtime = new UvRuntime({ home });

    await expect(runtime.ensureVenv({ name: 'mlx', packages: ['mlx-lm==0.25.3'] })).rejects.toThrow(
      /does not include the Python runtime/i,
    );
  });
});

describe('Ollama emulation listener', () => {
  it('never binds when the build forbids it, whatever the user setting says', async () => {
    const controller = createOllamaEmulationController({
      fetch: () => {
        throw new Error('listener must never start');
      },
      port: 0,
      allowListener: false,
    });

    const status = await controller.reconfigure({ enabled: true, emulateOllama: true });

    expect(status.listening).toBe(false);
  });

  it('still honors the user setting in an ordinary build', async () => {
    const controller = createOllamaEmulationController({
      fetch: () => (() => new Response('ok')) as never,
      port: 0,
    });

    const status = await controller.reconfigure({ enabled: true, emulateOllama: true });
    expect(status.listening).toBe(true);
    await controller.stop();
  });
});
