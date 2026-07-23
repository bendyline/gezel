import { lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  adoptHistoricalLlamaCppAlias,
  assertMlxSourceComplete,
  isModelInstalled,
} from './model-cache.ts';

function makeDir(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'gezel-mlx-src-'));
  for (const f of files) writeFileSync(join(dir, f), 'x');
  return dir;
}

describe('assertMlxSourceComplete', () => {
  it('passes for a complete install (manifest + safetensors, no partials)', () => {
    const dir = makeDir(['manifest.json', 'model-00001-of-00002.safetensors', 'config.json']);
    expect(() => assertMlxSourceComplete(dir, 'qwen3.5-9b-q4')).not.toThrow();
  });

  it('throws "incomplete download" when .partial files are present (the gemma4-12b case)', () => {
    const dir = makeDir([
      'config.json.partial',
      'model-00001-of-00003.safetensors.partial',
      'tokenizer.json.partial',
    ]);
    expect(() => assertMlxSourceComplete(dir, 'gemma4-12b-q4')).toThrowError(
      /incomplete download.*\.partial file/s,
    );
  });

  it('throws when the manifest.json install marker is missing', () => {
    const dir = makeDir(['model-00001-of-00002.safetensors', 'config.json']);
    expect(() => assertMlxSourceComplete(dir, 'somemodel')).toThrowError(/no manifest\.json/);
  });

  it('throws when no .safetensors weights are present', () => {
    const dir = makeDir(['manifest.json', 'config.json']);
    expect(() => assertMlxSourceComplete(dir, 'somemodel')).toThrowError(
      /no \.safetensors weights/,
    );
  });

  it('throws "not found" for a missing dir, pointing at how to install', () => {
    expect(() => assertMlxSourceComplete(join(tmpdir(), 'no-such-mlx-dir-zzz'), 'm')).toThrowError(
      /MLX model not found.*Install m via the app/s,
    );
  });
});

describe('isModelInstalled', () => {
  it('requires both a valid manifest and the weights file named by it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gezel-model-complete-'));
    const modelDir = join(root, 'engines', 'sd-cpp', 'models', 'sdxl-lightning-4step');
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, 'weights.safetensors.partial'), 'unfinished');

    await expect(isModelInstalled(root, 'sd-cpp', 'sdxl-lightning-4step')).resolves.toBe(false);

    writeFileSync(
      join(modelDir, 'manifest.json'),
      JSON.stringify({ weightsFilename: 'weights.safetensors' }),
    );
    await expect(isModelInstalled(root, 'sd-cpp', 'sdxl-lightning-4step')).resolves.toBe(false);

    writeFileSync(join(modelDir, 'weights.safetensors'), 'complete');
    await expect(isModelInstalled(root, 'sd-cpp', 'sdxl-lightning-4step')).resolves.toBe(true);
  });
});

describe('adoptHistoricalLlamaCppAlias', () => {
  it('replaces an incomplete renamed-id download with the complete historical install', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gezel-model-alias-'));
    const models = join(root, 'engines', 'llama-cpp', 'models');
    const legacy = join(models, 'qwen3.5-2b');
    const current = join(models, 'qwen3.5-2b-q4');
    mkdirSync(legacy, { recursive: true });
    mkdirSync(current, { recursive: true });
    writeFileSync(join(legacy, 'weights.gguf'), 'same pinned weights');
    writeFileSync(
      join(legacy, 'manifest.json'),
      JSON.stringify({ weightsFilename: 'weights.gguf' }),
    );
    writeFileSync(join(current, 'weights.gguf.partial'), 'unfinished duplicate');
    const logs: string[] = [];

    const adopted = await adoptHistoricalLlamaCppAlias({
      cacheRoot: root,
      modelId: 'qwen3.5-2b-q4',
      log: (line) => logs.push(line),
    });

    expect(adopted).toBe(true);
    // Node reports Windows directory junctions as symbolic links via lstat.
    expect(lstatSync(current).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(current, 'weights.gguf'), 'utf8')).toBe('same pinned weights');
    expect(logs.join('\n')).toContain('reused llama-cpp/qwen3.5-2b');
  });

  it('does not reuse a historical directory without a complete install marker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gezel-model-alias-incomplete-'));
    const legacy = join(root, 'engines', 'llama-cpp', 'models', 'qwen3.5-4b');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'weights.gguf.partial'), 'unfinished');

    await expect(
      adoptHistoricalLlamaCppAlias({
        cacheRoot: root,
        modelId: 'qwen3.5-4b-q4',
        log: () => {},
      }),
    ).resolves.toBe(false);
  });
});
