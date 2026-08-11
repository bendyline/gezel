import type { CatalogService } from '@bendyline/gezel-catalog';
import { describe, expect, it } from 'vitest';
import type { LlamaCppModelManager } from '../providers/llama-cpp/index.js';
import type { MlxModelManager } from '../providers/mlx/index.js';
import {
  type EnsureEvent,
  KnownEnsureError,
  createEnsureModelOrchestrator,
  parseQualifiedModelId,
} from './ensure.js';

/**
 * Build a tiny stub catalog that responds to chat-model lookups from a
 * map. Any unknown id returns null (matches the real catalog's miss path).
 */
function stubCatalog(
  entries: Record<string, { llamaCpp?: unknown; mlx?: unknown; ds4?: unknown }>,
): CatalogService {
  return {
    get: async (kind: string, id: string) => {
      if (kind !== 'chat-model') return null;
      const manifest = entries[id];
      if (!manifest) return null;
      return {
        manifest: { kind: 'chat-model', id, ...manifest },
      } as unknown as Awaited<ReturnType<CatalogService['get']>>;
    },
  } as unknown as CatalogService;
}

interface FakeInstall {
  events: EnsureEvent[];
}

function stubLlamaCpp(opts: {
  installed?: Set<string>;
  installs?: Record<string, FakeInstall>;
}): LlamaCppModelManager {
  return {
    async resolveModel(id: string) {
      return opts.installed?.has(id) ? ({ id } as unknown as null) : null;
    },
    install: async function* (id: string) {
      const plan = opts.installs?.[id];
      if (!plan) {
        yield { type: 'error', error: `no plan for ${id}` };
        return;
      }
      for (const e of plan.events) yield e;
    },
  } as unknown as LlamaCppModelManager;
}

function stubMlx(opts: {
  installed?: Set<string>;
  installs?: Record<string, FakeInstall>;
}): MlxModelManager {
  return {
    async resolveModel(id: string) {
      return opts.installed?.has(id) ? ({ id } as unknown as null) : null;
    },
    install: async function* (id: string) {
      const plan = opts.installs?.[id];
      if (!plan) {
        yield { type: 'error', error: `no plan for ${id}` };
        return;
      }
      for (const e of plan.events) yield e;
    },
  } as unknown as MlxModelManager;
}

function makeOrchestrator(opts: {
  llamaCpp?: Parameters<typeof stubLlamaCpp>[0];
  ds4?: Parameters<typeof stubLlamaCpp>[0];
  mlx?: Parameters<typeof stubMlx>[0];
  catalog?: Parameters<typeof stubCatalog>[0];
  onInstallStart?: (info: { backend: 'llama-cpp' | 'mlx' | 'ds4'; catalogId: string }) => void;
}) {
  return createEnsureModelOrchestrator({
    llamaCpp: stubLlamaCpp(opts.llamaCpp ?? {}),
    ds4: stubLlamaCpp(opts.ds4 ?? {}),
    mlx: stubMlx(opts.mlx ?? {}),
    catalog: stubCatalog(opts.catalog ?? {}),
    ...(opts.onInstallStart ? { onInstallStart: opts.onInstallStart } : {}),
  });
}

describe('parseQualifiedModelId', () => {
  it('parses a backend-qualified id', () => {
    expect(parseQualifiedModelId('llama-cpp:qwen3-4b')).toEqual({
      backend: 'llama-cpp',
      catalogId: 'qwen3-4b',
    });
    expect(parseQualifiedModelId('mlx:gemma-2b')).toEqual({
      backend: 'mlx',
      catalogId: 'gemma-2b',
    });
    expect(parseQualifiedModelId('ds4:glm-5.2-754b-q2')).toEqual({
      backend: 'ds4',
      catalogId: 'glm-5.2-754b-q2',
    });
  });

  it('returns null for a bare id', () => {
    expect(parseQualifiedModelId('qwen3-4b')).toBeNull();
  });

  it('returns null for an unsupported backend', () => {
    expect(parseQualifiedModelId('ollama:llama3')).toBeNull();
  });

  it('returns null when the catalog id is missing', () => {
    expect(parseQualifiedModelId('llama-cpp:')).toBeNull();
    expect(parseQualifiedModelId('llama-cpp: ')).toBeNull();
  });
});

describe('EnsureModelOrchestrator — validation', () => {
  it('throws ambiguous_model on a bare id', async () => {
    const o = await makeOrchestrator({});
    await expect(o.ensure('qwen3-4b')).rejects.toBeInstanceOf(KnownEnsureError);
    await o
      .ensure('qwen3-4b')
      .catch((e) => expect((e as KnownEnsureError).code).toBe('ambiguous_model'));
  });

  it('throws unknown_model when the catalog has no entry', async () => {
    const o = await makeOrchestrator({});
    await expect(o.ensure('llama-cpp:no-such-model')).rejects.toMatchObject({
      code: 'unknown_model',
    });
  });

  it('throws no_source_for_backend when the catalog entry has no source for the requested backend', async () => {
    const o = await makeOrchestrator({
      catalog: { 'mlx-only-model': { mlx: { url: 'fake' } } }, // no llamaCpp block
    });
    await expect(o.ensure('llama-cpp:mlx-only-model')).rejects.toMatchObject({
      code: 'no_source_for_backend',
    });
  });
});

describe('EnsureModelOrchestrator — ready path', () => {
  it('returns ready when the model is already installed', async () => {
    const o = await makeOrchestrator({
      catalog: { 'already-installed': { llamaCpp: { url: 'x' } } },
      llamaCpp: { installed: new Set(['already-installed']) },
    });
    const result = await o.ensure('llama-cpp:already-installed');
    expect(result).toEqual({ status: 'ready', modelId: 'llama-cpp:already-installed' });
  });

  it('returns ready for an installed ds4-only model', async () => {
    const o = await makeOrchestrator({
      catalog: { 'ds4-ready': { ds4: { url: 'x' } } },
      ds4: { installed: new Set(['ds4-ready']) },
    });
    await expect(o.ensure('ds4:ds4-ready')).resolves.toEqual({
      status: 'ready',
      modelId: 'ds4:ds4-ready',
    });
  });
});

describe('EnsureModelOrchestrator — onInstallStart hook', () => {
  it('fires with backend + catalogId when a fresh job starts', async () => {
    const calls: Array<{ backend: string; catalogId: string }> = [];
    const o = await makeOrchestrator({
      catalog: { 'fresh-mlx': { mlx: { url: 'x' } } },
      mlx: { installs: { 'fresh-mlx': { events: [{ type: 'done', jobId: '', modelId: '' }] } } },
      onInstallStart: (info) => calls.push(info),
    });
    await o.ensure('mlx:fresh-mlx');
    expect(calls).toEqual([{ backend: 'mlx', catalogId: 'fresh-mlx' }]);
  });

  it('does not fire when the model is already installed', async () => {
    const calls: unknown[] = [];
    const o = await makeOrchestrator({
      catalog: { 'have-it': { mlx: { url: 'x' } } },
      mlx: { installed: new Set(['have-it']) },
      onInstallStart: (info) => calls.push(info),
    });
    await o.ensure('mlx:have-it');
    expect(calls).toHaveLength(0);
  });

  it('does not fire a second time when a concurrent ensure coalesces into the running job', async () => {
    const calls: unknown[] = [];
    const gate = new Promise<void>((r) => setTimeout(r, 40));
    const mlx = {
      async resolveModel() {
        return null;
      },
      install: async function* (): AsyncIterable<EnsureEvent> {
        yield { type: 'progress', bytesWritten: 0, totalBytes: 100, jobId: '', modelId: '' };
        await gate;
        yield { type: 'done', jobId: '', modelId: '' };
      },
    } as unknown as MlxModelManager;
    const o = await createEnsureModelOrchestrator({
      llamaCpp: stubLlamaCpp({}),
      ds4: stubLlamaCpp({}),
      mlx,
      catalog: stubCatalog({ 'fresh-mlx': { mlx: { url: 'x' } } }),
      onInstallStart: (info) => calls.push(info),
    });
    const [a, b] = await Promise.all([o.ensure('mlx:fresh-mlx'), o.ensure('mlx:fresh-mlx')]);
    expect(a.jobId).toBe(b.jobId);
    expect(calls).toHaveLength(1);
  });

  it('a throwing hook does not abort the install job', async () => {
    const o = await makeOrchestrator({
      catalog: { 'fresh-mlx': { mlx: { url: 'x' } } },
      mlx: { installs: { 'fresh-mlx': { events: [{ type: 'done', jobId: '', modelId: '' }] } } },
      onInstallStart: () => {
        throw new Error('boom');
      },
    });
    const result = await o.ensure('mlx:fresh-mlx');
    expect(result.status).toBe('downloading');
    await new Promise((r) => setTimeout(r, 30));
    expect(o.getJob(result.jobId!)?.status).toBe('done');
  });
});

describe('EnsureModelOrchestrator — job lifecycle', () => {
  it('starts a job for a not-installed model and surfaces a jobId', async () => {
    const o = await makeOrchestrator({
      catalog: { 'fresh-model': { llamaCpp: { url: 'x' } } },
      llamaCpp: {
        installs: {
          'fresh-model': {
            events: [
              { type: 'progress', bytesWritten: 0, totalBytes: 100, jobId: '', modelId: '' },
              { type: 'done', jobId: '', modelId: '' },
            ],
          },
        },
      },
    });
    const result = await o.ensure('llama-cpp:fresh-model');
    expect(result.status).toBe('downloading');
    expect(result.jobId).toBeTruthy();
    expect(result.modelId).toBe('llama-cpp:fresh-model');

    // Wait for the async install loop to drain.
    await new Promise((r) => setTimeout(r, 30));
    const snap = o.getJob(result.jobId!);
    expect(snap?.status).toBe('done');
    expect(snap?.events.some((e) => e.type === 'done')).toBe(true);
    expect(snap?.events.some((e) => e.type === 'progress')).toBe(true);
  });

  it('starts ds4 installs through the ds4 model manager', async () => {
    const o = await makeOrchestrator({
      catalog: { 'ds4-download': { ds4: { url: 'x' } } },
      ds4: {
        installs: {
          'ds4-download': {
            events: [{ type: 'done', jobId: '', modelId: '' }],
          },
        },
      },
    });
    const result = await o.ensure('ds4:ds4-download');
    expect(result).toMatchObject({ status: 'downloading', modelId: 'ds4:ds4-download' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(o.getJob(result.jobId!)?.status).toBe('done');
  });

  it('coalesces concurrent ensure calls for the same model into one job', async () => {
    // Gated install: the iterable yields `progress`, then awaits a
    // promise that the test resolves at the end. While the install is
    // paused, the per-model slot stays claimed, so a second `ensure`
    // call observes the in-flight job and gets back the SAME jobId.
    let releaseInstall: () => void = () => {};
    const installGate = new Promise<void>((r) => {
      releaseInstall = r;
    });
    const llamaCpp = {
      async resolveModel(): Promise<null> {
        return null;
      },
      install: async function* (): AsyncIterable<EnsureEvent> {
        yield { type: 'progress', bytesWritten: 0, totalBytes: 100, jobId: '', modelId: '' };
        await installGate;
        yield { type: 'done', jobId: '', modelId: '' };
      },
    } as unknown as LlamaCppModelManager;
    const o = await createEnsureModelOrchestrator({
      llamaCpp,
      ds4: stubLlamaCpp({}),
      mlx: stubMlx({}),
      catalog: stubCatalog({ 'slow-model': { llamaCpp: { url: 'x' } } }),
    });

    const a = await o.ensure('llama-cpp:slow-model');
    const b = await o.ensure('llama-cpp:slow-model');
    expect(a.jobId).toBeTruthy();
    expect(a.jobId).toBe(b.jobId);

    // Release the install loop so the background worker can complete
    // and vitest's test runner doesn't hang on the dangling promise.
    releaseInstall();
    await new Promise((r) => setTimeout(r, 30));
  });

  it('a subscriber receives both replayed history and live events', async () => {
    const o = await makeOrchestrator({
      catalog: { 'replay-model': { llamaCpp: { url: 'x' } } },
      llamaCpp: {
        installs: {
          'replay-model': {
            events: [
              { type: 'progress', bytesWritten: 10, totalBytes: 100, jobId: '', modelId: '' },
              { type: 'progress', bytesWritten: 50, totalBytes: 100, jobId: '', modelId: '' },
              { type: 'done', jobId: '', modelId: '' },
            ],
          },
        },
      },
    });
    const result = await o.ensure('llama-cpp:replay-model');
    // Subscribe AFTER the install loop has had time to drain — every
    // event lands in `events[]` and is replayed.
    await new Promise((r) => setTimeout(r, 30));
    const received: EnsureEvent[] = [];
    o.subscribeJob(result.jobId!, (e) => received.push(e));
    expect(received.length).toBeGreaterThanOrEqual(3);
    expect(received[received.length - 1]?.type).toBe('done');
  });

  it('terminal error event flips job status to error', async () => {
    const o = await makeOrchestrator({
      catalog: { 'bad-model': { llamaCpp: { url: 'x' } } },
      llamaCpp: {
        installs: {
          'bad-model': {
            events: [{ type: 'error', error: 'sha mismatch', jobId: '', modelId: '' }],
          },
        },
      },
    });
    const result = await o.ensure('llama-cpp:bad-model');
    await new Promise((r) => setTimeout(r, 30));
    const snap = o.getJob(result.jobId!);
    expect(snap?.status).toBe('error');
  });

  it('after the job completes the per-model slot is freed and a new ensure starts a fresh job', async () => {
    const o = await makeOrchestrator({
      catalog: { 'rerun-model': { llamaCpp: { url: 'x' } } },
      llamaCpp: {
        installs: {
          'rerun-model': {
            events: [{ type: 'error', error: 'transient', jobId: '', modelId: '' }],
          },
        },
      },
    });
    const first = await o.ensure('llama-cpp:rerun-model');
    await new Promise((r) => setTimeout(r, 30));
    const second = await o.ensure('llama-cpp:rerun-model');
    expect(second.jobId).not.toBe(first.jobId);
  });
});
