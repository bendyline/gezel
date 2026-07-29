import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetSourceIndexCache,
  assertLocalEngineSource,
  chatModelSources,
} from './model-sources.ts';
import { defaultProvider } from './providers.ts';

// These assert against the real committed catalog index.json, using stable
// fixtures: `qwen3.5-4b-q4` ships all three engine sources; the GGUF-only
// `nemotron3-super-120b-q4` ships llamaCpp only (no MLX quant upstream); and
// `gemma4-e4b-q8` ships both llama.cpp and MLX weights.

const originalGildeDataDir = process.env.GEZEL_GILDE_DATA_DIR;
let syntheticDataDir: string | undefined;

function useSyntheticIndex(manifests: Array<Record<string, unknown>>): void {
  syntheticDataDir = mkdtempSync(join(tmpdir(), 'gezel-model-sources-'));
  const chatModelsDir = join(syntheticDataDir, 'chat-models');
  mkdirSync(chatModelsDir, { recursive: true });
  writeFileSync(
    join(chatModelsDir, 'index.json'),
    JSON.stringify({ entries: manifests.map((manifest) => ({ manifest })) }),
  );
  process.env.GEZEL_GILDE_DATA_DIR = syntheticDataDir;
  _resetSourceIndexCache();
}

afterEach(() => {
  if (originalGildeDataDir === undefined) delete process.env.GEZEL_GILDE_DATA_DIR;
  else process.env.GEZEL_GILDE_DATA_DIR = originalGildeDataDir;
  _resetSourceIndexCache();
  if (syntheticDataDir) rmSync(syntheticDataDir, { recursive: true, force: true });
  syntheticDataDir = undefined;
});

describe('chatModelSources', () => {
  it('reports the sources a model actually ships', () => {
    expect(chatModelSources('qwen3.5-4b-q4')).toEqual({
      ollama: true,
      llamaCpp: true,
      mlx: true,
      ds4: false,
    });
    expect(chatModelSources('nemotron3-super-120b-q4')).toMatchObject({
      llamaCpp: true,
      mlx: false,
    });
  });

  it('reports MLX for Gemma-4 E4B now that the catalog ships a supported build', () => {
    expect(chatModelSources('gemma4-e4b-q8')).toMatchObject({
      llamaCpp: true,
      mlx: true,
    });
  });

  it('reports mlx: false for a source explicitly flagged with disabledReason', () => {
    useSyntheticIndex([
      {
        id: 'known-broken-mlx',
        llamaCpp: { huggingfaceRepo: 'example/gguf' },
        mlx: {
          huggingfaceRepo: 'example/mlx',
          disabledReason: 'The current runtime cannot load this architecture.',
        },
      },
    ]);

    expect(chatModelSources('known-broken-mlx')).toEqual({
      ollama: false,
      llamaCpp: true,
      mlx: false,
      ds4: false,
    });
  });

  it('returns undefined for ids not in the catalog index (cloud/CLI models)', () => {
    expect(chatModelSources('claude-sonnet-4-6')).toBeUndefined();
  });
});

describe('assertLocalEngineSource', () => {
  it('throws — naming the engine to use instead — when the local engine has no weights', () => {
    expect(() => assertLocalEngineSource('mlx', 'nemotron3-super-120b-q4')).toThrowError(
      /no mlx weights.*--provider llama-cpp/s,
    );
  });

  it('throws for an explicitly disabled MLX build and steers to llama-cpp', () => {
    useSyntheticIndex([
      {
        id: 'known-broken-mlx',
        llamaCpp: { huggingfaceRepo: 'example/gguf' },
        mlx: {
          huggingfaceRepo: 'example/mlx',
          disabledReason: 'The current runtime cannot load this architecture.',
        },
      },
    ]);

    expect(() => assertLocalEngineSource('mlx', 'known-broken-mlx')).toThrowError(
      /no mlx weights.*--provider llama-cpp/s,
    );
  });

  it('passes when the model ships weights for the chosen engine', () => {
    expect(() => assertLocalEngineSource('llama-cpp', 'nemotron3-super-120b-q4')).not.toThrow();
    expect(() => assertLocalEngineSource('mlx', 'qwen3.5-4b-q4')).not.toThrow();
    expect(() => assertLocalEngineSource('mlx', 'gemma4-e4b-q8')).not.toThrow();
    expect(() => assertLocalEngineSource('llama-cpp', 'gemma4-e4b-q8')).not.toThrow();
  });

  it('is a no-op for cloud/CLI providers (no catalog source to check)', () => {
    expect(() => assertLocalEngineSource('anthropic', 'claude-sonnet-4-6')).not.toThrow();
    expect(() => assertLocalEngineSource('codex-cli', 'gpt-5.5')).not.toThrow();
  });

  it('is a no-op for unknown model ids (defer to downstream warm)', () => {
    expect(() => assertLocalEngineSource('mlx', 'no-such-model-zzz')).not.toThrow();
  });
});

describe('defaultProvider', () => {
  it('defaults to MLX on Apple Silicon, llama-cpp everywhere else', () => {
    const expected =
      process.platform === 'darwin' && process.arch === 'arm64' ? 'mlx' : 'llama-cpp';
    expect(defaultProvider()).toBe(expected);
  });
});
