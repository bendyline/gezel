import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildLlamaCppProvider } from './build-provider.js';

type Failure = Error & { code?: string; isActionable?: boolean };

const MODEL = 'gemma4-e4b-q4';

function inventory(installed: unknown[], active: unknown[] = []) {
  return {
    listInstalled: vi.fn(async () => installed),
    getActiveInstalls: vi.fn(() => active),
    resolveModel: vi.fn(async () => null),
    resolveDefaultModel: vi.fn(async () => null),
  };
}

async function failure(opts: {
  models: ReturnType<typeof inventory>;
  ensureEngine?: () => { detail: string; failed?: boolean } | undefined;
}): Promise<Failure> {
  try {
    await buildLlamaCppProvider({
      config: { defaultModel: { 'llama-cpp': MODEL } } as never,
      affinity: undefined,
      home: 'unused',
      llamaCppModels: opts.models as never,
      ...(opts.ensureEngine ? { ensureEngine: opts.ensureEngine } : {}),
    });
  } catch (err) {
    return err as Failure;
  }
  throw new Error('expected the build to fail');
}

const downloadingEngine = () => ({
  detail: 'On-device engine (llama-server, cuda) is downloading. It’ll be ready shortly.',
});

describe('a llama.cpp chat that cannot answer yet', () => {
  beforeEach(() => {
    // No engine binary, no external server, no hand-pinned weights file.
    vi.stubEnv('GEZEL_LLAMA_SERVER_BIN', '');
    vi.stubEnv('GEZEL_LLAMA_SERVER_URL', '');
    vi.stubEnv('GEZEL_LLAMA_CPP_MODEL', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('names the missing model before the missing engine, and still fetches the engine', async () => {
    const ensureEngine = vi.fn(downloadingEngine);
    const err = await failure({ models: inventory([]), ensureEngine });
    expect(err.code).toBe('model-not-ready');
    expect(err.isActionable).toBe(true);
    expect(err.message).toContain('no model is installed yet');
    expect(err.message).not.toContain('engine');
    expect(ensureEngine).toHaveBeenCalledTimes(1);
  });

  it('says how far the model download has got', async () => {
    const err = await failure({
      models: inventory(
        [],
        [{ catalogId: MODEL, bytesWritten: 1, totalBytes: 4, phase: 'downloading' }],
      ),
      ensureEngine: downloadingEngine,
    });
    expect(err.code).toBe('model-not-ready');
    expect(err.message).toContain('25% downloaded');
  });

  it('waits on the engine once a model is on disk', async () => {
    const err = await failure({
      models: inventory([{ id: MODEL }]),
      ensureEngine: downloadingEngine,
    });
    expect(err.code).toBe('engine-not-ready');
    expect(err.message).toContain('is downloading');
  });

  it('keeps a failed engine download a fault', async () => {
    const err = await failure({
      models: inventory([{ id: MODEL }]),
      ensureEngine: () => ({
        detail: "On-device engine couldn't be downloaded: 404",
        failed: true,
      }),
    });
    expect(err.code).toBeUndefined();
    expect(err.isActionable).toBe(true);
  });
});
