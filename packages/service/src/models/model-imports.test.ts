import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import {
  type CatalogItemDetail,
  type CatalogItemSummary,
  type CatalogKind,
  type ChatModelManifest,
  IMPORTED_CHAT_MODEL_ENTRY_FILE,
  isImportedChatModel,
} from '@bendyline/gezel';
import {
  CatalogService,
  type CatalogSource,
  ImportedChatModelsSource,
} from '@bendyline/gezel-catalog';
import { GezmodelManager } from '@bendyline/gezel-inference/internal/models/gezmodel';
import { createImportedChatModelReader } from '@bendyline/gezel-inference/internal/models/imports/entry-store';
import {
  HubRequestError,
  HuggingFaceModelImporter,
} from '@bendyline/gezel-inference/internal/models/imports/importer';
import { LocalModelImports } from '@bendyline/gezel-inference/internal/models/imports/local-files';
import {
  GgufPrefixTooShortError,
  readGgufSummaryFromPrefix,
} from '@bendyline/gezel-inference/internal/providers/llama-cpp/gguf-metadata';
import {
  type InstallEvent,
  LlamaCppModelManager,
} from '@bendyline/gezel-inference/internal/providers/llama-cpp/models';
import {
  type MlxInstallEvent,
  MlxModelManager,
} from '@bendyline/gezel-inference/internal/providers/mlx/models';
import type { MemoryProfile } from '@bendyline/gezel-inference/internal/system/memory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMIT,
  type FakeRepo,
  REPO,
  buildGguf,
  chatGguf,
  fakeHub,
  sha256,
} from './model-import-fixture.js';

const roomyMac = {
  totalRamBytes: 64 * 1024 ** 3,
  gpuVramBytes: null,
  gpuMemoryKind: 'unified',
  usableBytes: 40 * 1024 ** 3,
  budgetBytes: 40 * 1024 ** 3,
  source: 'darwin-unified',
} as unknown as MemoryProfile;

function curatedSource(manifests: ChatModelManifest[]): CatalogSource {
  return {
    id: 'bundled',
    label: 'Bundled',
    listKinds: async () => ['chat-model'] as CatalogKind[],
    list: async (kind: CatalogKind): Promise<CatalogItemSummary[]> =>
      kind === 'chat-model'
        ? manifests.map((manifest) => ({ sourceId: 'bundled', kind, manifest }))
        : [],
    get: async (kind: CatalogKind, id: string): Promise<CatalogItemDetail | null> => {
      const manifest = manifests.find((m) => m.id === id);
      return manifest && kind === 'chat-model' ? { sourceId: 'bundled', kind, manifest } : null;
    },
    listVersions: async () => [],
    readItemFile: async () => null,
  };
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gezel-hf-import-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function setup(
  repo: FakeRepo,
  curated: ChatModelManifest[] = [],
  opts: { appleSilicon?: boolean } = {},
) {
  const fetchImpl = fakeHub(repo);
  const reader = createImportedChatModelReader({ home, env: {} });
  const catalog = new CatalogService([
    curatedSource(curated),
    new ImportedChatModelsSource(
      reader,
      async (id) => curated.find((manifest) => manifest.id === id) ?? null,
    ),
  ]);
  const models = new LlamaCppModelManager({
    home,
    catalog,
    fetchImpl,
    resolveBackend: () => 'cpu',
  });
  const mlxModels = new MlxModelManager({ home, catalog, fetchImpl });
  const importer = new HuggingFaceModelImporter({
    home,
    catalog,
    llamaCppModels: models,
    mlxModels,
    fetchImpl,
    memoryProfile: async () => roomyMac,
    backend: () => 'cpu',
    hasHubToken: () => false,
    appleSilicon: () => opts.appleSilicon ?? true,
  });
  const local = new LocalModelImports({
    home,
    catalog,
    llamaCppModels: models,
    memoryProfile: async () => roomyMac,
  });
  return { catalog, models, mlxModels, importer, local, reader };
}

async function drain(events: AsyncIterable<InstallEvent>): Promise<InstallEvent[]> {
  const out: InstallEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('readGgufSummaryFromPrefix', () => {
  it('parses from a prefix and asks for more when the header runs past it', () => {
    const blob = chatGguf();
    const summary = readGgufSummaryFromPrefix(blob, blob.length, { includeTensorTypes: true });
    expect(summary.architecture).toBe('qwen3');
    expect(summary.tokenizerModel).toBe('gpt2');
    expect(summary.sizeLabel).toBe('8B');
    expect(summary.tensorTypeCounts).toEqual({ 12: 2, 0: 1 });
    expect(summary.parameterCount).toBe(64 * 100 + 64 * 64 + 64);
    expect(() => readGgufSummaryFromPrefix(blob.subarray(0, 120), blob.length)).toThrow(
      GgufPrefixTooShortError,
    );
  });
});

describe('HuggingFaceModelImporter', () => {
  it('reviews a GGUF repo: picks a quant, reads its header, and passes it', async () => {
    const q4 = chatGguf();
    const q8 = chatGguf([['general.file_type', 7]]);
    const { importer } = setup({
      files: {
        'Tiny-Qwen-Q4_K_M.gguf': q4,
        'Tiny-Qwen-Q8_0.gguf': q8,
        'README.md': Buffer.from('# hi'),
      },
      license: 'apache-2.0',
    });
    const review = await importer.review({ reference: `https://huggingface.co/${REPO}` });
    expect(review.source).toMatchObject({ repo: REPO, revision: COMMIT });
    expect(review.selectedFile).toBe('Tiny-Qwen-Q4_K_M.gguf');
    expect(review.choices.map((choice) => choice.quant).sort()).toEqual(['Q4_K_M', 'Q8_0']);
    expect(review.details).toMatchObject({
      architecture: 'qwen3',
      parameterSize: '8B',
      contextWindow: 40_960,
      supportsTools: true,
    });
    expect(review.license).toBe('apache-2.0');
    expect(review.blocked).toBe(false);
    expect(review.checks.filter((item) => item.status === 'fail')).toEqual([]);
    expect(review.id).toMatch(/^hf-tiny-qwen-q4-k-m-/);
  });

  it('blocks a gated repo and an engine-unknown design', async () => {
    const gated = setup({ files: { 'm-Q4_K_M.gguf': chatGguf() }, gated: 'manual' });
    const gatedReview = await gated.importer.review({ repo: REPO });
    expect(gatedReview.blocked).toBe(true);
    expect(gatedReview.checks.find((item) => item.id === 'access')?.status).toBe('fail');

    const unknown = setup({
      files: { 'm-Q4_K_M.gguf': chatGguf([['general.architecture', 'not-a-design']]) },
    });
    const unknownReview = await unknown.importer.review({ repo: REPO });
    expect(unknownReview.blocked).toBe(true);
    expect(unknownReview.checks.find((item) => item.id === 'architecture')?.status).toBe('fail');
  });

  it('says plainly when a repo holds no GGUF', async () => {
    const { importer } = setup({ files: { 'model.safetensors': Buffer.alloc(10) } });
    await expect(importer.review({ repo: REPO })).rejects.toThrow(/no model Gezel can run/);
    await expect(importer.review({ reference: 'not a model' })).rejects.toBeInstanceOf(
      HubRequestError,
    );
  });

  it('points at the catalog entry that pins the same bytes', async () => {
    const q4 = chatGguf();
    const curated = {
      schemaVersion: 1,
      kind: 'chat-model',
      id: 'tiny-qwen-q4',
      name: 'Tiny Qwen',
      description: 'curated',
      tags: [],
      maintainer: { name: 'gezel' },
      version: '1.0.0',
      releasedAt: '2026-01-01',
      parameterSize: '8B',
      approxSizeBytes: q4.length,
      supportsTools: true,
      llamaCpp: {
        huggingfaceRepo: REPO,
        filename: 'Tiny-Qwen-Q4_K_M.gguf',
        sha256: sha256(q4),
        approxSizeBytes: q4.length,
      },
      availableVersions: [],
    } as ChatModelManifest;
    const { importer } = setup({ files: { 'Tiny-Qwen-Q4_K_M.gguf': q4 } }, [curated]);
    const review = await importer.review({ repo: REPO });
    expect(review.catalogMatch).toEqual({ id: 'tiny-qwen-q4', name: 'Tiny Qwen' });
  });

  it('confirms, then the ordinary installer downloads and verifies it like a catalog model', async () => {
    const q4 = chatGguf();
    const projector = buildGguf({ meta: [['general.architecture', 'clip']] });
    const { importer, models, catalog } = setup({
      files: { 'Tiny-Qwen-Q4_K_M.gguf': q4, 'mmproj-Tiny-Qwen-F16.gguf': projector },
    });
    const review = await importer.review({ repo: REPO });
    expect(review.projector?.path).toBe('mmproj-Tiny-Qwen-F16.gguf');
    const { id } = await importer.confirm({
      repo: REPO,
      revision: COMMIT,
      file: review.selectedFile,
    });
    expect(id).toBe(review.id);

    const detail = await catalog.get('chat-model', id);
    expect(detail?.sourceId).toBe('imported');
    expect(isImportedChatModel(detail?.manifest as ChatModelManifest)).toBe(true);

    const events = await drain(models.install(id));
    expect(events.at(-1)).toEqual({ type: 'done', id });
    const installed = await models.resolveModel(id);
    expect(installed?.architecture).toBe('qwen3');
    expect(installed?.mmprojPath).toBeDefined();
    const dir = join(home, 'engines', 'llama-cpp', 'models', id);
    expect(existsSync(join(dir, IMPORTED_CHAT_MODEL_ENTRY_FILE))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
      fileSha256: Record<string, string>;
      catalogVersion: string;
    };
    // The entry is beside the payload, never part of it.
    expect(Object.keys(manifest.fileSha256).sort()).toEqual([
      'Tiny-Qwen-Q4_K_M.gguf',
      'mmproj-Tiny-Qwen-F16.gguf',
    ]);

    await models.delete(id);
    expect(await catalog.get('chat-model', id)).toBeNull();
  });

  it('refuses to confirm a review that does not pass', async () => {
    const { importer } = setup({
      files: { 'm-Q4_K_M.gguf': chatGguf([['tokenizer.chat_template', '']]) },
    });
    const noTemplate = buildGguf({
      meta: [
        ['general.architecture', 'qwen3'],
        ['tokenizer.ggml.model', 'gpt2'],
      ],
    });
    const blocked = setup({ files: { 'm-Q4_K_M.gguf': noTemplate } });
    const review = await blocked.importer.review({ repo: REPO });
    expect(review.blocked).toBe(true);
    await expect(
      blocked.importer.confirm({ repo: REPO, revision: COMMIT, file: 'm-Q4_K_M.gguf' }),
    ).rejects.toThrow(/Conversation format/);
    await expect(
      importer.confirm({ repo: REPO, revision: COMMIT, file: 'other.gguf' }),
    ).rejects.toBeInstanceOf(HubRequestError);
  });

  it('carries its catalog entry through a .gezmodel bundle to another home', async () => {
    const q4 = chatGguf();
    const { importer, models, catalog } = setup({ files: { 'Tiny-Qwen-Q4_K_M.gguf': q4 } });
    const review = await importer.review({ repo: REPO });
    const { id } = await importer.confirm({
      repo: REPO,
      revision: COMMIT,
      file: review.selectedFile,
    });
    await drain(models.install(id));
    const none = {} as never;
    const bundle = await new GezmodelManager({
      home,
      catalog,
      llamaCpp: models,
      mlx: none,
      ds4: none,
    }).export('llama-cpp', id);
    expect(bundle.manifest.files.some((file) => file.path.includes('.gezel-catalog-entry'))).toBe(
      false,
    );

    const otherHome = mkdtempSync(join(tmpdir(), 'gezel-hf-import-other-'));
    try {
      const otherCatalog = new CatalogService([
        new ImportedChatModelsSource(createImportedChatModelReader({ home: otherHome, env: {} })),
      ]);
      const otherModels = new LlamaCppModelManager({
        home: otherHome,
        catalog: otherCatalog,
        resolveBackend: () => 'cpu',
      });
      const bundles = new GezmodelManager({
        home: otherHome,
        catalog: otherCatalog,
        llamaCpp: otherModels,
        mlx: none,
        ds4: none,
      });
      const scanned = await bundles.scanUpload(
        bundle.stream as unknown as import('node:stream').Readable,
      );
      await bundles.confirmImport(scanned.importId, false);
      expect((await otherCatalog.get('chat-model', id))?.sourceId).toBe('imported');
      expect((await otherModels.resolveModel(id))?.architecture).toBe('qwen3');
    } finally {
      rmSync(otherHome, { recursive: true, force: true });
    }
  });
});

// ── MLX, settings, and files from this computer ──

const MLX_REPO_FILES = (config: Record<string, unknown> = {}) => ({
  'config.json': Buffer.from(
    JSON.stringify({
      model_type: 'qwen3',
      num_hidden_layers: 2,
      num_attention_heads: 4,
      num_key_value_heads: 2,
      hidden_size: 64,
      max_position_embeddings: 40_960,
      quantization: { bits: 4, group_size: 64 },
      ...config,
    }),
  ),
  'tokenizer_config.json': Buffer.from(
    JSON.stringify({ chat_template: '{% if tools %}{{ tools }}{% endif %}<|im_start|>' }),
  ),
  'tokenizer.json': Buffer.from('{"model":{}}'),
  'generation_config.json': Buffer.from(
    JSON.stringify({ temperature: 0.6, top_p: 0.95, top_k: 20 }),
  ),
  'model.safetensors': Buffer.alloc(4096, 3),
  'modeling_custom.py': Buffer.from('import os'),
  'README.md': Buffer.from('# mlx'),
});
const MLX_PLAIN = [
  'config.json',
  'tokenizer_config.json',
  'tokenizer.json',
  'generation_config.json',
];

function curatedQwen(): ChatModelManifest {
  return {
    schemaVersion: 1,
    kind: 'chat-model',
    id: 'qwen3-8b-q4',
    name: 'Qwen3 8B',
    description: 'curated',
    tags: [],
    maintainer: { name: 'gezel' },
    version: '1.0.0',
    releasedAt: '2026-01-01',
    parameterSize: '8B',
    approxSizeBytes: 1000,
    supportsTools: true,
    upstream: 'https://huggingface.co/Qwen/Qwen3-8B',
    style: { family: 'qwen', reasoningFormat: 'think', toolCallFormat: 'qwen-xml' },
    behaviors: ['prompt.terse-tool-calls'],
    tuning: {
      sampling: { temperature: 0.7, topP: 0.8, topK: 20 },
      reasoning: { thinkingBudget: 3072 },
      engine: { llamaCpp: { spec: { nMax: 4, mtp: true } } },
    },
    llamaCpp: {
      huggingfaceRepo: 'ggml-org/Qwen3-8B-GGUF',
      filename: 'Qwen3-8B-Q4_K_M.gguf',
      sha256: 'c'.repeat(64),
      approxSizeBytes: 1000,
    },
    availableVersions: [],
  } as ChatModelManifest;
}

async function drainMlx(events: AsyncIterable<MlxInstallEvent>): Promise<MlxInstallEvent[]> {
  const out: MlxInstallEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('MLX imports', () => {
  it('reviews an MLX build, hashes its plain-git files, and never takes code', async () => {
    const { importer } = setup({
      files: MLX_REPO_FILES(),
      plainGit: MLX_PLAIN,
      tags: ['mlx'],
      license: 'apache-2.0',
    });
    const review = await importer.review({ repo: REPO });
    expect(review.engine).toBe('mlx');
    expect(review.selectedFile).toBe('');
    expect(review.details).toMatchObject({
      architecture: 'qwen3',
      quantization: '4bit',
      supportsTools: true,
    });
    expect(review.blocked).toBe(false);
    expect(review.checks.find((item) => item.id === 'customCode')?.status).toBe('pass');
    expect(review.tuning).toEqual({ from: 'author' });
  });

  it('confirms, then the MLX installer downloads only the data files', async () => {
    const { importer, mlxModels, catalog } = setup({
      files: MLX_REPO_FILES(),
      plainGit: MLX_PLAIN,
      tags: ['mlx'],
    });
    const review = await importer.review({ repo: REPO });
    const confirmed = await importer.confirm({ repo: REPO, revision: COMMIT, file: '' });
    expect(confirmed).toMatchObject({ engine: 'mlx', id: review.id });
    const manifest = (await catalog.get('chat-model', review.id))?.manifest as ChatModelManifest;
    expect(manifest.mlx?.files.map((file) => file.name).sort()).toEqual([
      'config.json',
      'generation_config.json',
      'model.safetensors',
      'tokenizer.json',
      'tokenizer_config.json',
    ]);
    expect(manifest.tuning?.sampling).toMatchObject({ temperature: 0.6, topP: 0.95, topK: 20 });
    const events = await drainMlx(mlxModels.install(review.id));
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    const dir = join(home, 'engines', 'mlx', 'models', review.id);
    expect(existsSync(join(dir, 'modeling_custom.py'))).toBe(false);
    expect(existsSync(join(dir, IMPORTED_CHAT_MODEL_ENTRY_FILE))).toBe(true);
  });

  it('refuses a build that asks to run its own code, and MLX off Apple silicon', async () => {
    const custom = setup({
      files: MLX_REPO_FILES({ auto_map: { AutoModel: 'modeling_custom.Model' } }),
      plainGit: MLX_PLAIN,
      tags: ['mlx'],
    });
    const review = await custom.importer.review({ repo: REPO });
    expect(review.blocked).toBe(true);
    expect(review.checks.find((item) => item.id === 'customCode')?.status).toBe('fail');

    // A video processor config reaches the same loader.
    const video = setup(
      {
        files: {
          ...MLX_REPO_FILES(),
          'video_preprocessor_config.json': Buffer.from(
            JSON.stringify({ auto_map: { AutoVideoProcessor: 'modeling_custom.Processor' } }),
          ),
        },
        plainGit: [...MLX_PLAIN, 'video_preprocessor_config.json'],
        tags: ['mlx'],
      },
      [],
    );
    const videoReview = await video.importer.review({ repo: REPO });
    expect(videoReview.checks.find((item) => item.id === 'customCode')?.status).toBe('fail');

    const pc = setup({ files: MLX_REPO_FILES(), plainGit: MLX_PLAIN, tags: ['mlx'] }, [], {
      appleSilicon: false,
    });
    const pcReview = await pc.importer.review({ repo: REPO });
    expect(pcReview.checks.find((item) => item.id === 'platform')?.status).toBe('fail');
  });

  it('tells original weights apart from an MLX build', async () => {
    const { importer } = setup({
      files: MLX_REPO_FILES({ quantization: undefined }),
      plainGit: MLX_PLAIN,
      tags: ['transformers'],
    });
    await expect(importer.review({ repo: 'someone/Tiny-Qwen-GGUF' })).rejects.toThrow(
      /original weights/,
    );
  });
});

describe('imported model settings', () => {
  it("borrows a curated model's settings, live, when the base model matches", async () => {
    const { importer, catalog } = setup(
      { files: { 'Tiny-Qwen-Q4_K_M.gguf': chatGguf() }, baseModel: 'Qwen/Qwen3-8B' },
      [curatedQwen()],
    );
    const review = await importer.review({ repo: REPO });
    expect(review.tuning).toEqual({
      from: 'catalog',
      catalogId: 'qwen3-8b-q4',
      catalogName: 'Qwen3 8B',
    });
    const { id } = await importer.confirm({
      repo: REPO,
      revision: COMMIT,
      file: review.selectedFile,
    });
    const manifest = (await catalog.get('chat-model', id))?.manifest as ChatModelManifest;
    expect(manifest.style?.family).toBe('qwen');
    expect(manifest.behaviors).toEqual(['prompt.terse-tool-calls']);
    expect(manifest.tuning?.reasoning?.thinkingBudget).toBe(3072);
    // The donor's launch settings describe its own files, never this one's.
    expect(manifest.tuning?.engine).toBeUndefined();
  });

  it("falls back to the base model author's sampling", async () => {
    const { importer, catalog } = setup({
      files: { 'Tiny-Qwen-Q4_K_M.gguf': chatGguf() },
      baseModel: 'Qwen/Qwen3-8B',
      others: {
        'Qwen/Qwen3-8B': {
          'generation_config.json': Buffer.from(
            JSON.stringify({ do_sample: true, temperature: 0.6, top_p: 0.95, top_k: 20 }),
          ),
        },
      },
    });
    const review = await importer.review({ repo: REPO });
    expect(review.tuning).toEqual({ from: 'author' });
    const { id } = await importer.confirm({
      repo: REPO,
      revision: COMMIT,
      file: review.selectedFile,
    });
    const manifest = (await catalog.get('chat-model', id))?.manifest as ChatModelManifest;
    expect(manifest.tuning?.sampling).toEqual({ temperature: 0.6, topP: 0.95, topK: 20 });
  });
});

describe('GGUF files from this computer', () => {
  it('receives, reviews and adds a file without downloading anything', async () => {
    const { local, models, catalog } = setup({ files: {} });
    const { importId } = await local.create();
    const bytes = chatGguf();
    const staged = await local.receive(importId, 'My-Qwen-Q4_K_M.gguf', Readable.from([bytes]));
    expect(staged).toMatchObject({ sizeBytes: bytes.length, sha256: sha256(bytes) });
    expect((await local.status(importId)).bytesReceived).toBe(bytes.length);

    const review = await local.review(importId);
    expect(review.source.kind).toBe('local-file');
    expect(review.blocked).toBe(false);
    expect(review.checks.some((item) => item.id === 'access')).toBe(false);

    const result = await local.confirm(importId);
    expect(result).toMatchObject({ engine: 'llama-cpp', id: review.id, installed: true });
    expect(result.id).toMatch(/^local-my-qwen-q4-k-m-/);
    expect((await models.resolveModel(result.id))?.architecture).toBe('qwen3');
    expect((await catalog.get('chat-model', result.id))?.manifest.tags).toContain(
      'from-local-file',
    );
    // There is nowhere to fetch it from again.
    const events = await drain(models.install(result.id));
    expect(events.at(-1)).toMatchObject({ type: 'error' });
    expect((await models.listIncomplete()).length).toBe(0);
  });

  it('waits for a file still arriving, and never publishes a leftover partial', async () => {
    const { local, models } = setup({ files: {} });
    const { importId } = await local.create();
    await local.receive(importId, 'My-Qwen-Q4_K_M.gguf', Readable.from([chatGguf()]));
    const slow = new PassThrough();
    const arriving = local.receive(importId, 'extra-Q8_0.gguf', slow);
    for (let i = 0; i < 100; i += 1) {
      if ((await local.status(importId)).files.some((file) => !file.complete)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await expect(local.confirm(importId)).rejects.toThrow(/still arriving/);
    slow.destroy(new Error('stopped'));
    await expect(arriving).rejects.toThrow();

    // What an upload cut off by a crash leaves behind.
    const stage = join(home, '.transactions', 'local-model-imports', importId, 'files');
    writeFileSync(join(stage, 'extra-Q8_0.gguf.partial'), 'half');
    const result = await local.confirm(importId);
    const installed = await models.resolveModel(result.id);
    expect(installed).not.toBeNull();
    expect(readdirSync(dirname(installed?.weightsPath ?? ''))).not.toContain(
      'extra-Q8_0.gguf.partial',
    );
  });

  it('refuses names that are not plain .gguf files, and a second model in one import', async () => {
    const { local } = setup({ files: {} });
    const { importId } = await local.create();
    await expect(
      local.receive(importId, '../escape.gguf', Readable.from([Buffer.alloc(4)])),
    ).rejects.toBeInstanceOf(HubRequestError);
    await expect(
      local.receive(importId, 'notes.txt', Readable.from([Buffer.alloc(4)])),
    ).rejects.toBeInstanceOf(HubRequestError);
    await local.receive(importId, 'a-Q4_K_M.gguf', Readable.from([chatGguf()]));
    await local.receive(importId, 'b-Q8_0.gguf', Readable.from([chatGguf()]));
    await expect(local.review(importId)).rejects.toThrow(/more than one model/);
    await local.cancel(importId);
    await expect(local.status(importId)).rejects.toThrow(/ended/);
  });
});
