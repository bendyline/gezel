import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GezelConfig } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SecretKey, SecretStore } from '../../secrets/types.js';
import { type ResolvedInstalledModel, buildSdServerArgs, createImageProvider } from './factory.js';
import { GoogleAiImageProvider } from './google-ai.js';
import { MockImageProvider } from './mock.js';
import { OpenAIImageProvider } from './openai-image.js';
import { StableDiffusionCppProvider } from './sd-cpp.js';

function fakeSecrets(values: Record<string, string>): SecretStore {
  const map = new Map(Object.entries(values));
  const keyOf = (k: SecretKey) =>
    k.kind === 'providerCredential'
      ? `pc:${k.name}`
      : k.kind === 'toolset'
        ? `ts:${k.toolsetId}:${k.fieldId}`
        : `k:${k.kind}`;
  return {
    backend: 'file',
    async get(key) {
      return map.get(keyOf(key)) ?? null;
    },
    async set(key, value) {
      map.set(keyOf(key), value);
    },
    async delete(key) {
      map.delete(keyOf(key));
    },
    async has(key) {
      return map.has(keyOf(key));
    },
    async listForToolset() {
      return [];
    },
  };
}

/**
 * Exercise the factory's selection rules. The concrete class tells us
 * which branch was picked without having to introspect internal state.
 */

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-image-factory-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('createImageProvider selection rules', () => {
  it('returns MockImageProvider when GEZEL_MOCK_PROVIDER=1', async () => {
    const provider = await createImageProvider({
      home,
      env: { GEZEL_MOCK_PROVIDER: '1' },
    });
    expect(provider).toBeInstanceOf(MockImageProvider);
    expect(provider.name).toBe('mock');
  });

  it('returns SD.cpp adaptor with no supervisor when GEZEL_SD_SERVER_URL is set', async () => {
    const provider = await createImageProvider({
      home,
      env: { GEZEL_SD_SERVER_URL: 'http://my-server:1234' },
    });
    expect(provider).toBeInstanceOf(StableDiffusionCppProvider);
  });

  it('returns SD.cpp adaptor with a supervisor when GEZEL_SD_SERVER_BIN is set', async () => {
    const provider = await createImageProvider({
      home,
      env: { GEZEL_SD_SERVER_BIN: '/path/to/sd-server' },
    });
    expect(provider).toBeInstanceOf(StableDiffusionCppProvider);
  });

  it('returns SD.cpp adaptor pointing at the default loopback URL by default', async () => {
    const provider = await createImageProvider({
      home,
      env: {},
    });
    expect(provider).toBeInstanceOf(StableDiffusionCppProvider);
  });

  it('mock flag takes precedence over other env vars', async () => {
    const provider = await createImageProvider({
      home,
      env: {
        GEZEL_MOCK_PROVIDER: '1',
        GEZEL_SD_SERVER_URL: 'http://nope:8080',
        GEZEL_SD_SERVER_BIN: '/nope',
      },
    });
    expect(provider).toBeInstanceOf(MockImageProvider);
  });

  it('returns GoogleAiImageProvider when imageProvider=google-ai (key present)', async () => {
    const config = { imageProvider: 'google-ai' } as GezelConfig;
    const secrets = fakeSecrets({ 'pc:googleAiApiKey': 'AIzatestkey1234' });
    const provider = await createImageProvider({ home, env: {}, config, secrets });
    expect(provider).toBeInstanceOf(GoogleAiImageProvider);
    expect(provider.name).toBe('google-ai');
  });

  it('returns GoogleAiImageProvider with health=not-configured when key missing', async () => {
    const config = { imageProvider: 'google-ai' } as GezelConfig;
    const secrets = fakeSecrets({});
    const provider = await createImageProvider({ home, env: {}, config, secrets });
    expect(provider).toBeInstanceOf(GoogleAiImageProvider);
    const health = await provider.health();
    expect(health.status).toBe('not-configured');
  });

  it('returns OpenAIImageProvider when imageProvider=openai', async () => {
    const config = { imageProvider: 'openai' } as GezelConfig;
    const secrets = fakeSecrets({ 'pc:openaiApiKey': 'sk-test' });
    const provider = await createImageProvider({ home, env: {}, config, secrets });
    expect(provider).toBeInstanceOf(OpenAIImageProvider);
    expect(provider.name).toBe('openai');
  });

  it('returns MockImageProvider when imageProvider=mock', async () => {
    const config = { imageProvider: 'mock' } as GezelConfig;
    const provider = await createImageProvider({ home, env: {}, config });
    expect(provider).toBeInstanceOf(MockImageProvider);
  });

  it('falls back to sd-cpp when imageProvider is undefined', async () => {
    const provider = await createImageProvider({ home, env: {}, config: {} as GezelConfig });
    expect(provider).toBeInstanceOf(StableDiffusionCppProvider);
  });

  it('forces the native provider for an engine broker with legacy cloud config', async () => {
    const config = { imageProvider: 'openai' } as GezelConfig;
    const secrets = fakeSecrets({ 'pc:openaiApiKey': 'must-not-be-used' });
    const provider = await createImageProvider({
      home,
      env: {},
      config,
      secrets,
      localOnly: true,
    });
    expect(provider).toBeInstanceOf(StableDiffusionCppProvider);
  });
});

/**
 * `buildSdServerArgs` translates a resolved model into sd-server CLI
 * flags. The aux-role-to-flag mapping is purely `--${aux.role}`, so
 * the only thing tests need to lock in is that every supported role
 * is wired through and emits the expected flag — including the newer
 * `llm` role that FLUX.2-class models use in place of T5+CLIP.
 */
describe('buildSdServerArgs — aux role mapping', () => {
  function modelWithAux(aux: Array<{ role: string; path: string }>): ResolvedInstalledModel {
    return {
      id: 'test',
      name: 'Test',
      approxSizeBytes: 1,
      installedAt: '2026-01-01T00:00:00Z',
      weightsPath: '/tmp/weights.gguf',
      weightsKind: 'diffusion-model',
      auxiliaryFiles: aux,
    };
  }

  it('emits --diffusion-model for diffusion-model weightsKind, --model for checkpoint', () => {
    const dm = buildSdServerArgs(modelWithAux([]), 1234);
    expect(dm).toContain('--diffusion-model');
    expect(dm).not.toContain('--model');
    const ckpt = buildSdServerArgs({ ...modelWithAux([]), weightsKind: 'checkpoint' }, 1234);
    expect(ckpt).toContain('--model');
    expect(ckpt).not.toContain('--diffusion-model');
  });

  it('emits --vae / --clip_l / --t5xxl for FLUX.1-style aux files (regression)', () => {
    const args = buildSdServerArgs(
      modelWithAux([
        { role: 'vae', path: '/tmp/ae.safetensors' },
        { role: 'clip_l', path: '/tmp/clip_l.safetensors' },
        { role: 't5xxl', path: '/tmp/t5xxl.safetensors' },
      ]),
      1234,
    );
    expect(args).toContain('--vae');
    expect(args).toContain('/tmp/ae.safetensors');
    expect(args).toContain('--clip_l');
    expect(args).toContain('/tmp/clip_l.safetensors');
    expect(args).toContain('--t5xxl');
    expect(args).toContain('/tmp/t5xxl.safetensors');
  });

  it('emits --llm for the FLUX.2-style LLM text encoder', () => {
    // FLUX.2 Klein 4B and dev both drop the T5+CLIP pair for a single
    // LLM encoder (Qwen3 for Klein, Mistral-Small for dev). sd-cpp's
    // --llm flag accepts a GGUF and the aux role maps verbatim.
    const args = buildSdServerArgs(
      modelWithAux([
        { role: 'vae', path: '/tmp/flux2-decoder.safetensors' },
        { role: 'llm', path: '/tmp/qwen3-4b.gguf' },
      ]),
      1234,
    );
    expect(args).toContain('--llm');
    expect(args).toContain('/tmp/qwen3-4b.gguf');
    // Make sure --llm and its argument are adjacent (one flag, one
    // value, in that order) — buildSdServerArgs splits flag+value into
    // two array entries.
    const idx = args.indexOf('--llm');
    expect(args[idx + 1]).toBe('/tmp/qwen3-4b.gguf');
  });

  it('appends --vae-tiling + listen flags for tiling-compatible models', () => {
    const args = buildSdServerArgs(modelWithAux([]), 8765);
    expect(args).toContain('--vae-tiling');
    expect(args).toContain('--listen-ip');
    expect(args[args.indexOf('--listen-ip') + 1]).toBe('127.0.0.1');
    expect(args).toContain('--listen-port');
    expect(args[args.indexOf('--listen-port') + 1]).toBe('8765');
  });

  it('skips --vae-tiling for models whose VAE seams under tiling (Krea)', () => {
    // Krea 2's Qwen-Image VAE shows tile-boundary streaks under
    // --vae-tiling, so the flag is gated off for it.
    const args = buildSdServerArgs({ ...modelWithAux([]), id: 'krea-2-turbo-q4' }, 8765);
    expect(args).not.toContain('--vae-tiling');
    // The listen flags are still emitted.
    expect(args).toContain('--listen-port');
  });

  it('launches distilled checkpoint models with their fast sample-step default', () => {
    const args = buildSdServerArgs(
      {
        ...modelWithAux([]),
        id: 'sdxl-lightning-4step',
        weightsKind: 'checkpoint',
      },
      8765,
    );
    expect(args).toContain('--steps');
    expect(args[args.indexOf('--steps') + 1]).toBe('4');
  });
});
