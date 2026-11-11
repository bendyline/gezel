import { describe, expect, it } from 'vitest';
import { IdRegex } from '../schemas/catalog-id.js';
import type { ChatModelManifest } from '../schemas/catalog.js';
import { layoutGgufRepo } from './gguf-files.js';
import {
  IMPORTED_CHAT_MODEL_TAG,
  IMPORTED_THINKING_BUDGET_TOKENS,
  LOCAL_FILE_SOURCE_REPO,
  applyTuningDonor,
  baseModelRefs,
  buildImportedChatModelEntry,
  buildImportedChatModelManifest,
  buildImportedMlxManifest,
  buildLocalGgufManifest,
  findTuningDonor,
  importedChatModelId,
  isImportedChatModel,
  isLocalFileChatModel,
  mlxParameterSize,
  parseImportedChatModelEntry,
  samplingFromGenerationConfig,
  sanitizeImportedChatModelManifest,
} from './manifest.js';
import { mlxConfigFacts } from './mlx.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const sha = (n: number) => n.toString(16).padStart(64, '0');
const GB = 1024 ** 3;

const layout = layoutGgufRepo([
  { path: 'Qwen3-8B-Q4_K_M.gguf', sizeBytes: 5 * GB, sha256: sha(1) },
  { path: 'BF16/Qwen3-8B-BF16-00001-of-00002.gguf', sizeBytes: 8 * GB, sha256: sha(2) },
  { path: 'BF16/Qwen3-8B-BF16-00002-of-00002.gguf', sizeBytes: 8 * GB, sha256: sha(3) },
  { path: 'mmproj-F16.gguf', sizeBytes: GB, sha256: sha(4) },
]);
const single = layout.choices.find((choice) => choice.quant === 'Q4_K_M');
const split = layout.choices.find((choice) => choice.quant === 'BF16');

const header = {
  version: 3,
  architecture: 'qwen3',
  name: 'Qwen3 8B',
  sizeLabel: '8B',
  contextLength: 40_960,
  chatTemplate: '{% if tools %}{{ tools }}{% endif %}<think>',
  tokenizerModel: 'gpt2',
  kvBytesPerTokenF16: 147_456,
  kvFixedBytesF16: 0,
};

describe('importedChatModelId', () => {
  it('is a valid catalog id, readable, and distinct per upload', () => {
    const a = importedChatModelId('unsloth/Qwen3-8B-GGUF', 'Qwen3-8B-Q4_K_M.gguf', 'Q4_K_M');
    const b = importedChatModelId('bartowski/Qwen3-8B-GGUF', 'Qwen3-8B-Q4_K_M.gguf', 'Q4_K_M');
    expect(a).toMatch(/^hf-qwen3-8b-q4-k-m-[a-z0-9]{6}$/);
    expect(a).not.toBe(b);
    expect(IdRegex.test(a)).toBe(true);
    const long = importedChatModelId(
      `someone/${'A-Very-Long-Model-Name-'.repeat(6)}GGUF`,
      'x.gguf',
      'UD-Q4_K_XL',
    );
    expect(long.length).toBeLessThanOrEqual(64);
    expect(IdRegex.test(long)).toBe(true);
  });
});

describe('buildImportedChatModelManifest', () => {
  it('pins the reviewed commit and every SHA-256', () => {
    if (!single) throw new Error('fixture');
    const manifest = buildImportedChatModelManifest({
      repo: 'unsloth/Qwen3-8B-GGUF',
      revision: COMMIT,
      choice: single,
      projector: layout.projectors[0],
      header,
      license: 'apache-2.0',
      reviewedAt: '2026-11-10T00:00:00.000Z',
    });
    expect(isImportedChatModel(manifest)).toBe(true);
    expect(manifest.tags).toContain(IMPORTED_CHAT_MODEL_TAG);
    expect(manifest.parameterSize).toBe('8B');
    expect(manifest.supportsTools).toBe(true);
    expect(manifest.contextWindow).toBe(40_960);
    expect(manifest.kvBytesPerTokenF16).toBe(147_456);
    expect(manifest.tuning?.reasoning?.thinkingBudget).toBe(IMPORTED_THINKING_BUDGET_TOKENS);
    expect(manifest.llamaCpp).toMatchObject({
      huggingfaceRepo: 'unsloth/Qwen3-8B-GGUF',
      revision: COMMIT,
      filename: 'Qwen3-8B-Q4_K_M.gguf',
      sha256: sha(1),
      quantization: 'Q4_K_M',
      mmproj: { filename: 'mmproj-F16.gguf', sha256: sha(4), sizeBytes: GB },
    });
  });

  it('writes split models as shards', () => {
    if (!split) throw new Error('fixture');
    const manifest = buildImportedChatModelManifest({
      repo: 'unsloth/Qwen3-8B-GGUF',
      revision: COMMIT,
      choice: split,
      header,
      reviewedAt: '2026-11-10T00:00:00.000Z',
    });
    expect(manifest.llamaCpp?.shards?.map((shard) => shard.sha256)).toEqual([sha(2), sha(3)]);
    expect(manifest.llamaCpp?.filename).toBeUndefined();
  });

  it('refuses a file without a published checksum', () => {
    if (!single) throw new Error('fixture');
    const { sha256: _drop, ...unhashed } = single.files[0] ?? { path: '', sizeBytes: 0 };
    expect(() =>
      buildImportedChatModelManifest({
        repo: 'unsloth/Qwen3-8B-GGUF',
        revision: COMMIT,
        choice: { ...single, files: [unhashed] },
        header,
        reviewedAt: '2026-11-10T00:00:00.000Z',
      }),
    ).toThrow(/SHA-256/);
  });
});

describe('sanitizeImportedChatModelManifest', () => {
  if (!single) throw new Error('fixture');
  const manifest = buildImportedChatModelManifest({
    repo: 'unsloth/Qwen3-8B-GGUF',
    revision: COMMIT,
    choice: single,
    header,
    reviewedAt: '2026-11-10T00:00:00.000Z',
  });

  it('round-trips what an import writes', () => {
    expect(sanitizeImportedChatModelManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(
      manifest,
    );
  });

  it('drops engine flags, behaviors and other sources a hand edit adds', () => {
    const tampered = {
      ...manifest,
      behaviors: ['prompt.anything'],
      tuning: {
        reasoning: { thinkingBudget: 1_000_000 },
        engine: { llamaCpp: { extraArgs: ['--rpc', 'evil:1'] } },
      },
      ollama: { tag: 'x' },
    };
    const clean = sanitizeImportedChatModelManifest(tampered);
    expect(clean?.behaviors).toBeUndefined();
    expect(clean?.ollama).toBeUndefined();
    expect(clean?.tuning?.engine).toBeUndefined();
    expect(clean?.tuning?.reasoning?.thinkingBudget).toBe(4 * IMPORTED_THINKING_BUDGET_TOKENS);
  });

  it('refuses entries that are not imports', () => {
    expect(sanitizeImportedChatModelManifest({ ...manifest, id: 'gemma4-e4b-q4' })).toBeNull();
    expect(sanitizeImportedChatModelManifest({ ...manifest, tags: ['gguf'] })).toBeNull();
    expect(
      sanitizeImportedChatModelManifest({
        ...manifest,
        llamaCpp: { ...manifest.llamaCpp, revision: 'main' },
      }),
    ).toBeNull();
  });
});

describe('settings for an imported model', () => {
  const curated = (overrides: Record<string, unknown> = {}) =>
    ({
      schemaVersion: 1,
      kind: 'chat-model',
      id: 'qwen3-8b-q4',
      name: 'Qwen3 8B',
      description: '',
      tags: [],
      maintainer: { name: 'gezel' },
      version: '1.0.0',
      releasedAt: '2026-01-01',
      parameterSize: '8B',
      approxSizeBytes: 1,
      supportsTools: true,
      upstream: 'https://huggingface.co/Qwen/Qwen3-8B',
      style: { family: 'qwen', reasoningFormat: 'think', toolCallFormat: 'qwen-xml' },
      tuning: {
        sampling: { temperature: 0.7 },
        engine: { llamaCpp: { spec: { nMax: 4, mtp: true } } },
      },
      llamaCpp: {
        huggingfaceRepo: 'ggml-org/Qwen3-8B-GGUF',
        filename: 'q.gguf',
        sha256: 'c'.repeat(64),
        approxSizeBytes: 1,
      },
      availableVersions: [],
      ...overrides,
    }) as ChatModelManifest;

  it('finds a donor by base model, however the reference is written', () => {
    const refs = baseModelRefs(['https://huggingface.co/Qwen/Qwen3-8B', ['qwen/qwen3-8b']]);
    expect(refs).toEqual(['Qwen/Qwen3-8B']);
    expect(
      findTuningDonor([curated()], refs, { engine: 'llama-cpp', parameterSize: '8B' })?.id,
    ).toBe('qwen3-8b-q4');
    // A different size of the same family is a different model.
    expect(findTuningDonor([curated()], refs, { engine: 'llama-cpp', parameterSize: '32B' })).toBe(
      undefined,
    );
    expect(findTuningDonor([curated()], ['Other/Model'], { engine: 'llama-cpp' })).toBe(undefined);
  });

  it("lends style and tuning, never the donor's launch settings", () => {
    if (!single) throw new Error('fixture');
    const imported = buildImportedChatModelManifest({
      repo: 'unsloth/Qwen3-8B-GGUF',
      revision: COMMIT,
      choice: single,
      header,
      reviewedAt: '2026-11-10T00:00:00.000Z',
    });
    const merged = applyTuningDonor(imported, curated());
    expect(merged.style?.family).toBe('qwen');
    expect(merged.tuning?.sampling?.temperature).toBe(0.7);
    expect(merged.tuning?.engine).toBeUndefined();
    expect(merged.llamaCpp).toEqual(imported.llamaCpp);
  });

  it("reads the author's sampling and ignores what is out of range", () => {
    expect(
      samplingFromGenerationConfig({
        temperature: 0.6,
        top_p: 0.95,
        top_k: 20,
        repetition_penalty: 1,
      }),
    ).toEqual({ temperature: 0.6, topP: 0.95, topK: 20 });
    expect(samplingFromGenerationConfig({ do_sample: false, temperature: 0.6 })).toBeUndefined();
    expect(samplingFromGenerationConfig({ temperature: 99 })).toBeUndefined();
    expect(samplingFromGenerationConfig('nope')).toBeUndefined();
  });
});

describe('entries and other sources', () => {
  it('wraps a manifest with its donor and refuses a donor that is itself an import', () => {
    if (!single) throw new Error('fixture');
    const manifest = buildImportedChatModelManifest({
      repo: 'unsloth/Qwen3-8B-GGUF',
      revision: COMMIT,
      choice: single,
      header,
      reviewedAt: '2026-11-10T00:00:00.000Z',
    });
    const entry = parseImportedChatModelEntry(
      JSON.parse(JSON.stringify(buildImportedChatModelEntry(manifest, 'qwen3-8b-q4'))),
    );
    expect(entry?.tuningFrom).toBe('qwen3-8b-q4');
    expect(
      parseImportedChatModelEntry({ manifest, tuningFrom: 'hf-other-abc123' })?.tuningFrom,
    ).toBe(undefined);
  });

  it('describes local files with a source that can never be downloaded', () => {
    if (!single) throw new Error('fixture');
    const local = buildLocalGgufManifest({
      choice: single,
      header,
      reviewedAt: '2026-11-10T00:00:00.000Z',
    });
    expect(local.id).toMatch(/^local-qwen3-8b-q4-k-m-/);
    expect(isLocalFileChatModel(local)).toBe(true);
    expect(local.llamaCpp?.huggingfaceRepo).toBe(LOCAL_FILE_SOURCE_REPO);
    expect(sanitizeImportedChatModelManifest(JSON.parse(JSON.stringify(local)))).toEqual(local);
    // A local entry pointing at a real repo is not a local entry.
    expect(
      sanitizeImportedChatModelManifest({
        ...local,
        llamaCpp: { ...local.llamaCpp, huggingfaceRepo: 'someone/model' },
      }),
    ).toBeNull();
  });

  it('builds an MLX entry from data files only', () => {
    const facts = mlxConfigFacts({ config: { model_type: 'qwen3', quantization: { bits: 4 } } });
    const manifest = buildImportedMlxManifest({
      repo: 'mlx-community/Qwen3-8B-4bit',
      revision: COMMIT,
      root: '',
      files: [
        { path: 'config.json', sizeBytes: 900, sha256: sha(5) },
        { path: 'model.safetensors', sizeBytes: 4e9, sha256: sha(6) },
      ],
      facts,
      parameterSize: mlxParameterSize('mlx-community/Qwen3-8B-4bit', facts, 4e9),
      reviewedAt: '2026-11-10T00:00:00.000Z',
    });
    expect(manifest.parameterSize).toBe('8B');
    expect(manifest.mlx?.quantization).toBe('4bit');
    expect(sanitizeImportedChatModelManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(
      manifest,
    );
    expect(() =>
      buildImportedMlxManifest({
        repo: 'mlx-community/Qwen3-8B-4bit',
        revision: COMMIT,
        root: '',
        files: [{ path: 'modeling.py', sizeBytes: 9, sha256: sha(7) }],
        facts,
        parameterSize: '8B',
        reviewedAt: '2026-11-10T00:00:00.000Z',
      }),
    ).toThrow(/not an MLX data file/);
  });
});
