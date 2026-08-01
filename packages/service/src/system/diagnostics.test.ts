import { SystemDiagnosticsSchema } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelInfo } from '../providers/types.js';
import {
  collectSystemDiagnostics,
  collectSystemDiagnosticsCached,
  resetSystemDiagnosticsCache,
} from './diagnostics.js';

function deps(overrides: {
  config?: Record<string, unknown> | null;
  models?: Partial<Record<string, ModelInfo[]>>;
  throwFor?: string[];
}) {
  const listModelsForProvider = vi.fn(async (name: string) => {
    if (overrides.throwFor?.includes(name)) throw new Error(`${name} not installed`);
    return overrides.models?.[name] ?? [];
  });
  return {
    home: '/nonexistent-home',
    store: {
      readConfig: async () => overrides.config ?? {},
    } as never,
    chat: { listModelsForProvider } as never,
    listModelsForProvider,
  };
}

const priorEnv = { ...process.env };

beforeEach(() => {
  resetSystemDiagnosticsCache();
  // The collector reads engine locations from env. Start from a clean slate
  // so a developer's real GEZEL_* vars can't make these tests pass locally
  // and fail in CI (or vice versa).
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GEZEL_')) delete process.env[key];
  }
});

afterEach(() => {
  process.env = { ...priorEnv };
});

describe('collectSystemDiagnostics', () => {
  it('produces a payload that satisfies the published schema', async () => {
    const result = await collectSystemDiagnostics(deps({}));
    expect(() => SystemDiagnosticsSchema.parse(result)).not.toThrow();
    expect(result.runtime.platform).toBe(process.platform);
    expect(result.runtime.arch).toBe(process.arch);
    expect(result.runtime.nodeVersion).toBe(process.versions.node);
  });

  it('omits absent optional fields rather than emitting undefined keys', async () => {
    const result = await collectSystemDiagnostics(deps({}));
    // No llama binary is set, so nothing build-related can be known.
    expect(Object.hasOwn(result.engine, 'llamaCppRevision')).toBe(false);
    expect(Object.hasOwn(result.engine, 'cudaToolkit')).toBe(false);
    expect(Object.hasOwn(result.engine, 'llamaCppBackendOverride')).toBe(false);
    expect(Object.hasOwn(result.models, 'defaultModel')).toBe(false);
  });

  it('lists installed local models with provider and size', async () => {
    const result = await collectSystemDiagnostics(
      deps({
        models: {
          'llama-cpp': [{ id: 'gemma4-26b-q4', name: 'Gemma 4', parameterSize: '26B' }],
          mlx: [{ id: 'qwen3-8b', name: 'Qwen 3' }],
        },
      }),
    );
    expect(result.models.installed).toEqual([
      { id: 'gemma4-26b-q4', provider: 'llama-cpp', parameterSize: '26B' },
      { id: 'qwen3-8b', provider: 'mlx' },
    ]);
  });

  it('excludes Ollama models — their tags are user-authored and can name an employer', async () => {
    const result = await collectSystemDiagnostics(
      deps({
        models: {
          ollama: [{ id: 'acme-corp/internal-7b:latest', name: 'Internal' }],
          'llama-cpp': [{ id: 'gemma4-26b-q4', name: 'Gemma 4' }],
        },
      }),
    );
    expect(JSON.stringify(result)).not.toContain('acme-corp');
    expect(result.models.installed).toHaveLength(1);
  });

  it('caps the installed-model list', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, name: `M${i}` }));
    const result = await collectSystemDiagnostics(deps({ models: { 'llama-cpp': many } }));
    expect(result.models.installed).toHaveLength(40);
  });

  it('survives every probe failing', async () => {
    const result = await collectSystemDiagnostics(
      deps({ config: null, throwFor: ['llama-cpp', 'mlx', 'ds4'] }),
    );
    expect(() => SystemDiagnosticsSchema.parse(result)).not.toThrow();
    expect(result.models.installed).toEqual([]);
    expect(result.models.defaultProvider).toBe('copilot');
  });

  it('reports the configured default provider and model', async () => {
    const result = await collectSystemDiagnostics(
      deps({ config: { provider: 'llama-cpp', defaultModel: { 'llama-cpp': 'gemma4-26b-q4' } } }),
    );
    expect(result.models.defaultProvider).toBe('llama-cpp');
    expect(result.models.defaultModel).toBe('gemma4-26b-q4');
  });

  it('never emits a path-shaped string, even when its inputs are all paths', async () => {
    // The tripwire: if someone later adds a field that carries a resolved
    // path, this fails without needing a real engine install.
    const result = await collectSystemDiagnostics(
      deps({
        config: {
          provider: 'llama-cpp',
          defaultModel: { 'llama-cpp': 'gemma4-26b-q4' },
          ollamaBaseUrl: 'http://internal-corp-host:11434',
          externalFolders: ['/Users/mike/secret-client-work'],
        },
        models: { 'llama-cpp': [{ id: 'gemma4-26b-q4', name: '/Users/mike/models/gemma.gguf' }] },
      }),
    );
    for (const [path, leaf] of stringLeaves(result)) {
      expect(leaf, `${path} looks like an absolute path`).not.toMatch(
        /^(\/|~|\$|[A-Za-z]:\\|\\\\)/,
      );
    }
    // Config fields outside the declared allowlist never reach the payload.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('internal-corp-host');
    expect(serialized).not.toContain('secret-client-work');
  });

  it('strips an undeclared field rather than shipping it', async () => {
    // This is the property the whole design leans on: the route parses on
    // the way out, so a handler that grows a `path` field leaks nothing.
    const valid = await collectSystemDiagnostics(deps({}));
    const parsed = SystemDiagnosticsSchema.parse({
      ...valid,
      enginePath: '/Users/mike/.gezel/engines/llama-cpp/llama-server',
    });
    expect(Object.hasOwn(parsed, 'enginePath')).toBe(false);
  });
});

describe('collectSystemDiagnosticsCached', () => {
  it('memoizes within the window and re-probes past it', async () => {
    const d = deps({ models: { 'llama-cpp': [{ id: 'a', name: 'A' }] } });
    let clock = 1_000_000;
    const now = () => clock;

    const first = await collectSystemDiagnosticsCached(d, now);
    clock += 30_000;
    const second = await collectSystemDiagnosticsCached(d, now);
    expect(second).toBe(first);
    expect(d.listModelsForProvider).toHaveBeenCalledTimes(3);

    clock += 31_000;
    const third = await collectSystemDiagnosticsCached(d, now);
    expect(third).not.toBe(first);
    expect(d.listModelsForProvider).toHaveBeenCalledTimes(6);
  });
});

/** Every string leaf in the payload, paired with its dotted key path. */
function stringLeaves(value: unknown, path = ''): [string, string][] {
  if (typeof value === 'string') return [[path || '(root)', value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => stringLeaves(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => stringLeaves(v, path ? `${path}.${k}` : k));
  }
  return [];
}
