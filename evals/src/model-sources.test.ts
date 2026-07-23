import { describe, expect, it } from 'vitest';
import { assertLocalEngineSource, chatModelSources } from './model-sources.ts';
import { defaultProvider } from './providers.ts';

// These assert against the real committed catalog index.json, using stable
// fixtures: `qwen3.5-4b-q4` ships all three engine sources; the GGUF-only
// `nemotron3-super-120b-q4` ships llamaCpp only (no MLX quant upstream); and
// `gemma4-e4b-q8` has an mlx block that is *disabled* (mlx-vlm can't load
// Gemma-4 E4B) — so it reports `mlx: false` despite the pinned repo/sha.

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

  it('reports mlx: false for a build flagged as broken on MLX (disabledReason)', () => {
    // Gemma-4 E4B keeps its mlx repo pin for the day an upstream fix lands,
    // but `mlx.disabledReason` means it must probe as having no MLX source.
    expect(chatModelSources('gemma4-e4b-q8')).toMatchObject({
      llamaCpp: true,
      mlx: false,
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

  it('throws for an MLX-disabled build, steering to llama-cpp (Gemma-4 E4B)', () => {
    expect(() => assertLocalEngineSource('mlx', 'gemma4-e4b-q8')).toThrowError(
      /no mlx weights.*--provider llama-cpp/s,
    );
  });

  it('passes when the model ships weights for the chosen engine', () => {
    expect(() => assertLocalEngineSource('llama-cpp', 'nemotron3-super-120b-q4')).not.toThrow();
    expect(() => assertLocalEngineSource('mlx', 'qwen3.5-4b-q4')).not.toThrow();
    // E4B's MLX build is disabled, but it still ships GGUF for llama-cpp.
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
