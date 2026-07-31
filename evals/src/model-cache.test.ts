import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  adoptHistoricalLlamaCppAlias,
  assertMlxSourceComplete,
  isModelInstalled,
  staleInstallReason,
} from './model-cache.ts';
import { _resetSourceIndexCache } from './model-sources.ts';

function makeDir(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'gezel-mlx-src-'));
  for (const f of files) writeFileSync(join(dir, f), 'x');
  return dir;
}

// Staleness is defined against the catalog index, so these tests pin a
// synthetic one rather than the committed content — otherwise a routine
// gilde bump would rewrite the expectations.
const originalGildeDataDir = process.env.GEZEL_GILDE_DATA_DIR;
let syntheticDataDir: string | undefined;

function useSyntheticIndex(manifests: Array<Record<string, unknown>>): void {
  syntheticDataDir = mkdtempSync(join(tmpdir(), 'gezel-model-cache-catalog-'));
  const chatModelsDir = join(syntheticDataDir, 'chat-models');
  mkdirSync(chatModelsDir, { recursive: true });
  writeFileSync(
    join(chatModelsDir, 'index.json'),
    JSON.stringify({ entries: manifests.map((manifest) => ({ manifest })) }),
  );
  process.env.GEZEL_GILDE_DATA_DIR = syntheticDataDir;
  _resetSourceIndexCache();
}

/** Install-side manifest as the install pipeline writes it. */
function writeInstall(
  root: string,
  modelId: string,
  manifest: Record<string, unknown>,
  extraFiles: string[] = [],
): string {
  const dir = join(root, 'engines', 'llama-cpp', 'models', modelId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, String(manifest.weightsFilename)), 'weights');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  for (const f of extraFiles) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), 'draft');
  }
  return dir;
}

afterEach(() => {
  if (originalGildeDataDir === undefined) delete process.env.GEZEL_GILDE_DATA_DIR;
  else process.env.GEZEL_GILDE_DATA_DIR = originalGildeDataDir;
  _resetSourceIndexCache();
  if (syntheticDataDir) rmSync(syntheticDataDir, { recursive: true, force: true });
  syntheticDataDir = undefined;
});

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

describe('staleInstallReason', () => {
  const CATALOG = {
    id: 'qwen3.6-27b-q4',
    version: '1.1.4',
    llamaCpp: {
      huggingfaceRepo: 'unsloth/Qwen3.6-27B-MTP-GGUF',
      filename: 'Qwen3.6-27B-Q4_K_M.gguf',
      sha256: 'a'.repeat(64),
    },
  };
  const install = {
    weightsFilename: 'Qwen3.6-27B-Q4_K_M.gguf',
    sha256: 'a'.repeat(64),
    huggingfaceRepo: 'unsloth/Qwen3.6-27B-MTP-GGUF',
    catalogVersion: '1.1.4',
  };
  const root = () => mkdtempSync(join(tmpdir(), 'gezel-stale-'));

  it('accepts an install matching the catalog', async () => {
    useSyntheticIndex([CATALOG]);
    const r = root();
    writeInstall(r, 'qwen3.6-27b-q4', install);
    await expect(
      staleInstallReason({ cacheRoot: r, engine: 'llama-cpp', modelId: 'qwen3.6-27b-q4' }),
    ).resolves.toBeNull();
  });

  it('flags changed upstream weights by sha256', async () => {
    useSyntheticIndex([CATALOG]);
    const r = root();
    writeInstall(r, 'qwen3.6-27b-q4', { ...install, sha256: 'b'.repeat(64) });
    await expect(
      staleInstallReason({ cacheRoot: r, engine: 'llama-cpp', modelId: 'qwen3.6-27b-q4' }),
    ).resolves.toMatch(/sha256 bbbbbbbbbbbb… != catalog aaaaaaaaaaaa…/);
  });

  // The wild-caught case: catalog repointed lmstudio-community -> unsloth MTP.
  it('flags a moved upstream repo', async () => {
    useSyntheticIndex([CATALOG]);
    const r = root();
    writeInstall(r, 'qwen3.6-27b-q4', {
      ...install,
      huggingfaceRepo: 'lmstudio-community/Qwen3.6-27B-GGUF',
    });
    await expect(
      staleInstallReason({ cacheRoot: r, engine: 'llama-cpp', modelId: 'qwen3.6-27b-q4' }),
    ).resolves.toMatch(/repo moved: lmstudio-community.* -> unsloth/);
  });

  it('flags an install predating a newly-added MTP draft sidecar', async () => {
    useSyntheticIndex([
      { ...CATALOG, llamaCpp: { ...CATALOG.llamaCpp, draftModel: { filename: 'mtp-draft.gguf' } } },
    ]);
    const r = root();
    writeInstall(r, 'qwen3.6-27b-q4', install);
    await expect(
      staleInstallReason({ cacheRoot: r, engine: 'llama-cpp', modelId: 'qwen3.6-27b-q4' }),
    ).resolves.toMatch(/missing draft \(MTP\) weights mtp-draft\.gguf/);

    writeInstall(r, 'qwen3.6-27b-q4', install, ['mtp-draft.gguf']);
    await expect(
      staleInstallReason({ cacheRoot: r, engine: 'llama-cpp', modelId: 'qwen3.6-27b-q4' }),
    ).resolves.toBeNull();
  });

  // The catalog names a draft by its upstream repo-relative path; the
  // installer flattens it into the model dir. Comparing full paths reported
  // a just-downloaded gemma4-26b-q4 as stale, which would re-evict and
  // refetch 14 GB on every sweep.
  it('matches a flattened draft against a catalog path carrying a subdirectory', async () => {
    useSyntheticIndex([
      {
        ...CATALOG,
        llamaCpp: {
          ...CATALOG.llamaCpp,
          draftModel: { filename: 'MTP/mtp-gemma-4-26B-A4B-it-Q4_0.gguf' },
        },
      },
    ]);
    const r = root();
    writeInstall(r, 'qwen3.6-27b-q4', install, ['mtp-gemma-4-26B-A4B-it-Q4_0.gguf']);
    await expect(
      staleInstallReason({ cacheRoot: r, engine: 'llama-cpp', modelId: 'qwen3.6-27b-q4' }),
    ).resolves.toBeNull();
  });

  it('falls back to catalogVersion when the precise fields are absent', async () => {
    useSyntheticIndex([{ id: 'm', version: '2.0.0', llamaCpp: { filename: 'w.gguf' } }]);
    const r = root();
    writeInstall(r, 'm', { weightsFilename: 'w.gguf', catalogVersion: '1.0.0' });
    await expect(
      staleInstallReason({ cacheRoot: r, engine: 'llama-cpp', modelId: 'm' }),
    ).resolves.toMatch(/catalogVersion 1\.0\.0 != catalog 2\.0\.0/);
  });

  it('never reports stale for a model the catalog does not index', async () => {
    useSyntheticIndex([]);
    const r = root();
    writeInstall(r, 'qwen3.6-27b-q4', install);
    await expect(
      staleInstallReason({ cacheRoot: r, engine: 'llama-cpp', modelId: 'qwen3.6-27b-q4' }),
    ).resolves.toBeNull();
  });

  it('compares a historical directory against the current catalog id', async () => {
    useSyntheticIndex([CATALOG]);
    const r = root();
    writeInstall(r, 'qwen3.6', { ...install, sha256: 'c'.repeat(64) });
    // `qwen3.6` resolves via core's legacy-id alias table, so the implicit
    // path finds the catalog entry today…
    await expect(
      staleInstallReason({ cacheRoot: r, engine: 'llama-cpp', modelId: 'qwen3.6' }),
    ).resolves.toMatch(/sha256/);
    // …and expectedId states the target outright, so the check survives the
    // two alias tables (core's and this module's) drifting apart.
    await expect(
      staleInstallReason({
        cacheRoot: r,
        engine: 'llama-cpp',
        modelId: 'qwen3.6',
        expectedId: 'qwen3.6-27b-q4',
      }),
    ).resolves.toMatch(/sha256/);
  });

  it('uses expectedId when the directory slug has no alias entry', async () => {
    useSyntheticIndex([CATALOG]);
    const r = root();
    writeInstall(r, 'some-unaliased-slug', { ...install, sha256: 'c'.repeat(64) });
    await expect(
      staleInstallReason({ cacheRoot: r, engine: 'llama-cpp', modelId: 'some-unaliased-slug' }),
    ).resolves.toBeNull();
    await expect(
      staleInstallReason({
        cacheRoot: r,
        engine: 'llama-cpp',
        modelId: 'some-unaliased-slug',
        expectedId: 'qwen3.6-27b-q4',
      }),
    ).resolves.toMatch(/sha256/);
  });
  // The MLX path cannot self-heal: those weights live in the user's dev home
  // and the harness only symlinks them, so `runner.ts` fails the trial with a
  // re-pull instruction instead of evicting. Wild-caught 2026-07-31 —
  // correcting four gemma MLX sources left every installed copy stale, and the
  // re-test meant to validate the fix would have re-run the old weights.
  it('detects a moved MLX source, which the runner cannot refetch', async () => {
    useSyntheticIndex([
      {
        id: 'gemma4-26b-q4',
        version: '1.2.1',
        mlx: {
          huggingfaceRepo: 'mlx-community/gemma-4-26B-A4B-it-qat-4bit',
          quantization: '4bit',
        },
      },
    ]);
    const r = mkdtempSync(join(tmpdir(), 'gezel-mlx-stale-'));
    const dir = join(r, 'engines', 'mlx', 'models', 'gemma4-26b-q4');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        huggingfaceRepo: 'mlx-community/gemma-4-26B-A4B-it-qat-nvfp4',
        quantization: 'nvfp4',
      }),
    );
    await expect(
      staleInstallReason({ cacheRoot: r, engine: 'mlx', modelId: 'gemma4-26b-q4' }),
    ).resolves.toMatch(/repo moved: .*nvfp4 -> .*qat-4bit/);
  });
});

describe('adoptHistoricalLlamaCppAlias', () => {
  it('refuses to adopt a historical install that is stale vs the current catalog', async () => {
    useSyntheticIndex([
      {
        id: 'qwen3.6-27b-q4',
        version: '1.1.4',
        llamaCpp: {
          huggingfaceRepo: 'unsloth/Qwen3.6-27B-MTP-GGUF',
          filename: 'weights.gguf',
          sha256: 'a'.repeat(64),
        },
      },
    ]);
    const root = mkdtempSync(join(tmpdir(), 'gezel-alias-stale-'));
    writeInstall(root, 'qwen3.6', {
      weightsFilename: 'weights.gguf',
      sha256: 'b'.repeat(64),
      huggingfaceRepo: 'lmstudio-community/Qwen3.6-27B-GGUF',
    });
    const logs: string[] = [];

    await expect(
      adoptHistoricalLlamaCppAlias({
        cacheRoot: root,
        modelId: 'qwen3.6-27b-q4',
        log: (l) => logs.push(l),
      }),
    ).resolves.toBe(false);
    expect(logs.join('\n')).toMatch(/not adopting llama-cpp\/qwen3\.6.*stale/);
  });

  it('replaces an incomplete renamed-id download with the complete historical install', async () => {
    // Empty index — no catalog identity to compare, so the alias path keeps
    // its original "same variant, different slug" behavior.
    useSyntheticIndex([]);
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
