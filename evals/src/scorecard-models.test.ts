import { describe, expect, it } from 'vitest';
import { type ScorecardFs, discoverScorecardModels, resolveModelEngine } from './scorecard.ts';

/** In-memory cache tree: path → dir entries / manifest JSON. */
function fakeFs(tree: Record<string, { dirs?: string[]; files?: string[]; manifest?: unknown }>) {
  const fs: ScorecardFs = {
    exists: (path) => path in tree || Object.keys(tree).some((key) => key === path),
    listDirs: (path) => tree[path]?.dirs ?? [],
    listFiles: (path) => tree[path]?.files ?? [],
    readJson: (path) => {
      const dir = path.replace(/\/manifest\.json$/, '');
      const manifest = tree[dir]?.manifest;
      return (manifest as Record<string, unknown> | undefined) ?? null;
    },
  };
  return fs;
}

const HOME = '/home';
const LLAMA = `${HOME}/.gezel-dev/engines/llama-cpp/models`;
const MLX = `${HOME}/.gezel-dev/engines/mlx/models`;
const DS4 = `${HOME}/.gezel-dev/engines/ds4/models`;

describe('discoverScorecardModels', () => {
  it('finds MLX models despite their sharded, weightsFilename-less layout', () => {
    // The bug this closes: a llama-cpp-shaped probe requires
    // `weightsFilename` from the manifest, which MLX installs do not have —
    // so the entire MLX cache was invisible to the sweep.
    const fs = fakeFs({
      [MLX]: { dirs: ['gemma4-e4b-q4'] },
      [`${MLX}/gemma4-e4b-q4`]: {
        manifest: { id: 'gemma4-e4b-q4', quantization: '4bit' },
        files: ['model-00001-of-00002.safetensors', 'config.json'],
      },
    });
    expect(discoverScorecardModels(HOME, fs)).toEqual([
      { id: 'gemma4-e4b-q4', engine: 'mlx', root: `${MLX}/gemma4-e4b-q4` },
    ]);
  });

  it('still requires a real weights file for llama-cpp installs', () => {
    const fs = fakeFs({
      [LLAMA]: { dirs: ['complete', 'partial'] },
      [`${LLAMA}/complete`]: { manifest: { weightsFilename: 'w.gguf' } },
      [`${LLAMA}/complete/w.gguf`]: {},
      [`${LLAMA}/partial`]: { manifest: { weightsFilename: 'missing.gguf' } },
    });
    expect(discoverScorecardModels(HOME, fs).map((m) => m.id)).toEqual(['complete']);
  });

  it('honors an engine the manifest declares over the root it sits in', () => {
    const fs = fakeFs({
      [DS4]: { dirs: ['deepseek'] },
      [`${DS4}/deepseek`]: { manifest: { engine: 'ds4', weightsFilename: 'w.bin' } },
      [`${DS4}/deepseek/w.bin`]: {},
    });
    expect(discoverScorecardModels(HOME, fs)[0]?.engine).toBe('ds4');
  });

  it('reports one entry per engine when a model is installed for several', () => {
    const fs = fakeFs({
      [LLAMA]: { dirs: ['shared'] },
      [`${LLAMA}/shared`]: { manifest: { weightsFilename: 'w.gguf' } },
      [`${LLAMA}/shared/w.gguf`]: {},
      [MLX]: { dirs: ['shared'] },
      [`${MLX}/shared`]: { manifest: {}, files: ['model.safetensors'] },
    });
    expect(discoverScorecardModels(HOME, fs).map((m) => m.engine)).toEqual(['llama-cpp', 'mlx']);
  });
});

describe('resolveModelEngine', () => {
  const candidates = [
    { id: 'both', engine: 'llama-cpp', root: '/a' },
    { id: 'both', engine: 'mlx', root: '/b' },
    { id: 'llama-only', engine: 'llama-cpp', root: '/c' },
    { id: 'ds4-only', engine: 'ds4', root: '/d' },
  ];

  it('prefers the platform default when the model has it', () => {
    expect(resolveModelEngine(candidates, 'both', { preferred: 'mlx' })?.engine).toBe('mlx');
  });

  it('falls back to whatever the model IS installed for', () => {
    // The bug this closes: pinning one provider for every model would have
    // handed `--provider mlx` to a ds4-only model and failed the cell.
    expect(resolveModelEngine(candidates, 'ds4-only', { preferred: 'mlx' })?.engine).toBe('ds4');
    expect(resolveModelEngine(candidates, 'llama-only', { preferred: 'mlx' })?.engine).toBe(
      'llama-cpp',
    );
  });

  it('skips rather than silently switching when a provider is forced', () => {
    expect(
      resolveModelEngine(candidates, 'ds4-only', { forced: 'mlx', preferred: 'mlx' }),
    ).toBeNull();
    expect(
      resolveModelEngine(candidates, 'both', { forced: 'llama-cpp', preferred: 'mlx' })?.engine,
    ).toBe('llama-cpp');
  });

  it('returns null for a model nothing has installed', () => {
    expect(resolveModelEngine(candidates, 'absent', { preferred: 'mlx' })).toBeNull();
  });
});
