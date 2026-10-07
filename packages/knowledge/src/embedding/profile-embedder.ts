/**
 * Profile-conformant embedder + tokenizer, driven entirely by a declarative
 * KnowledgeEmbeddingProfile — model repo, pinned revision, the exact ONNX
 * graph, pooling, and instruction prefixes all come from the profile object,
 * never from env-var regexes. This is what the offline CLI wires into the
 * compiler and the explicit-search path; the daemon wires its own pipeline
 * pool later.
 *
 * After loading, the files transformers.js fetched are hashed and compared
 * with the digests the profile pins (artifact-verify.ts). A profile that
 * declares digests is therefore served only by the very bytes that produced
 * its catalogs; anything else is refused as a different vector space.
 *
 * `@huggingface/transformers` stays a dynamic import (mirroring the
 * service's embed-core): the CLI must start instantly without it, and a
 * missing module surfaces as an actionable install message, not an
 * ERR_MODULE_NOT_FOUND. Honors GEZEL_HF_CACHE_DIR so CLI builds share the
 * daemon's model cache.
 */

import {
  type KnowledgeEmbeddingProfile,
  embeddingProfileArtifacts,
  profileUnitVector,
} from '@bendyline/gezk';
import { type VerifiedArtifacts, verifyProfileArtifacts } from './artifact-verify.js';
import {
  isExternalDataFile,
  missingPinnedFiles,
  pinnedLoadFiles,
  prefetchExternalData,
} from './pinned-files.js';

const MAX_BATCH = 8;
const MAX_CHARS = 8_000;

export interface ProfileEmbedder {
  readonly profile: KnowledgeEmbeddingProfile;
  /** What the loaded model files were checked against after loading. */
  readonly verification: VerifiedArtifacts;
  /**
   * Raw passage embed — takes ALREADY-PREFIXED texts (the compiler's
   * contract) and returns the model's own width; the compiler projects.
   */
  embed(texts: string[]): Promise<number[][]>;
  /** Query embed — applies the queryInstruction and the profile's projection itself. */
  embedQuery(text: string): Promise<Float32Array>;
  /** Profile-tokenizer token count (sync once loaded — chunking's contract). */
  countTokens(text: string): number;
  dispose(): Promise<void>;
}

/**
 * The `@huggingface/transformers` range this package supports, the same range
 * as its optional peer dependency (a test holds the two together). Error
 * messages quote it so the install command they print is exact.
 */
export const TRANSFORMERS_PEER_RANGE = '^4.3.1';

export class EmbedderUnavailableError extends Error {
  readonly isActionable = true;
  /** True when `@huggingface/transformers` could not be loaded at all, as opposed to a profile it cannot serve. */
  readonly runtimeMissing: boolean;
  constructor(message: string, options: { runtimeMissing?: boolean } = {}) {
    super(message);
    this.name = 'EmbedderUnavailableError';
    this.runtimeMissing = options.runtimeMissing ?? false;
  }
}

/** The slice of `@huggingface/transformers` this module drives; injectable for tests. */
export interface TransformersModule {
  pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<PipelineFn>;
  AutoTokenizer: {
    from_pretrained: (model: string, options?: Record<string, unknown>) => Promise<TokenizerFn>;
  };
  /**
   * Read a repo's config before choosing a loader. Optional so a test fake
   * that only knows the pipeline keeps working; without it every profile
   * loads through `pipeline`.
   */
  AutoConfig?: {
    from_pretrained: (
      model: string,
      options?: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
  };
  /** Multimodal encoders: loads the text session alone (see `isMultimodalEncoderConfig`). */
  AutoModel?: {
    from_pretrained: (model: string, options?: Record<string, unknown>) => Promise<EncoderModelFn>;
  };
  env: { cacheDir?: string; useFSCache?: boolean; allowRemoteModels?: boolean };
}

/** A tensor as this module reads it: flat data plus its shape. */
export interface TensorLike {
  data: ArrayLike<number>;
  dims: number[];
}

/** A tokenizer called on a batch, as the encoder path feeds a model directly. */
export type BatchTokenizerFn = TokenizerFn &
  ((
    texts: string[],
    options: { padding: boolean; truncation: boolean; max_length: number },
  ) => {
    attention_mask?: TensorLike;
  });

/** A text-session encoder: tokenized inputs in, named tensors out. */
export type EncoderModelFn = ((inputs: unknown) => Promise<Record<string, TensorLike>>) & {
  dispose?: () => Promise<unknown>;
};

export type PipelineFn = ((
  texts: string[],
  options: { pooling: string; normalize: boolean },
) => Promise<{ tolist(): number[][] }>) & { dispose?: () => Promise<void> };

export interface TokenizerFn {
  encode(text: string): number[];
}

/** Bytes fetched so far across every file a profile load pulls, summed. */
export interface ModelDownloadProgress {
  bytesDone: number;
  bytesTotal: number;
}

/**
 * Sum transformers.js's per-file `progress` callbacks into one running total.
 * A file whose response carried no length counts what it has read so far, so
 * the total never trails the bytes done. A cache hit that hands the runtime a
 * file path reports nothing, so a warm load stays silent.
 */
function aggregateDownloadProgress(
  onProgress: (progress: ModelDownloadProgress) => void,
): (info: Record<string, unknown>) => void {
  const files = new Map<string, { loaded: number; total: number }>();
  return (info) => {
    if (info.status !== 'progress') return;
    const loaded = typeof info.loaded === 'number' ? info.loaded : 0;
    const total = typeof info.total === 'number' ? info.total : 0;
    files.set(`${String(info.name)}/${String(info.file)}`, {
      loaded,
      total: Math.max(total, loaded),
    });
    let bytesDone = 0;
    let bytesTotal = 0;
    for (const file of files.values()) {
      bytesDone += file.loaded;
      bytesTotal += file.total;
    }
    onProgress({ bytesDone, bytesTotal });
  };
}

/** The load options that make transformers.js fetch exactly the profile's ONNX graph. */
export interface TransformersModelOptions {
  revision: string;
  dtype: string;
  subfolder: string;
  model_file_name: string;
}

// transformers.js picks the graph by appending a dtype suffix to the base
// file name; the profile pins the file, so the suffix is read back off it.
const ONNX_DTYPE_BY_SUFFIX: ReadonlyArray<[suffix: string, dtype: string]> = [
  ['_q4f16', 'q4f16'],
  ['_quantized', 'q8'],
  ['_uint8', 'uint8'],
  ['_int8', 'int8'],
  ['_bnb4', 'bnb4'],
  ['_fp16', 'fp16'],
  ['_q4', 'q4'],
];

const POOLING_BY_PROFILE: Partial<Record<KnowledgeEmbeddingProfile['pooling'], string>> = {
  mean: 'mean',
  cls: 'cls',
};

export function resolveTransformersModelOptions(
  profile: KnowledgeEmbeddingProfile,
): TransformersModelOptions {
  const { onnxFile, tokenizerFile } = embeddingProfileArtifacts(profile);
  if (tokenizerFile !== 'tokenizer.json') {
    throw new EmbedderUnavailableError(
      `profile ${profile.id} pins tokenizer file ${tokenizerFile}; this runtime loads tokenizer.json only`,
    );
  }
  const graph = transformersGraphOptions(onnxFile);
  if (!graph) {
    throw new EmbedderUnavailableError(
      `profile ${profile.id} pins ${onnxFile}; this runtime loads named ONNX graphs only`,
    );
  }
  return { revision: profile.model.revision, ...graph };
}

/**
 * The transformers.js options that select exactly one pinned ONNX graph:
 * its folder, its base name, and the dtype whose suffix transformers.js
 * appends to that name. A file with no recognized suffix loads as fp32 under
 * its full name, which selects the same file. Null for a path that is not a
 * named `.onnx` graph.
 */
export function transformersGraphOptions(
  onnxFile: string,
): { dtype: string; subfolder: string; model_file_name: string } | null {
  if (!onnxFile.endsWith('.onnx')) return null;
  const slash = onnxFile.lastIndexOf('/');
  const subfolder = slash === -1 ? '' : onnxFile.slice(0, slash);
  const base = onnxFile.slice(slash + 1, -'.onnx'.length);
  const variant = ONNX_DTYPE_BY_SUFFIX.find(([suffix]) => base.endsWith(suffix));
  const [suffix, dtype] = variant ?? ['', 'fp32'];
  const modelFileName = base.slice(0, base.length - suffix.length);
  if (modelFileName === '') return null;
  return { dtype, subfolder, model_file_name: modelFileName };
}

/**
 * A multimodal embedding model (one space for text, images, audio) carries
 * its media encoders' configs beside the text model's. Through the
 * `feature-extraction` pipeline it would load every encoder; the text path
 * needs only the text session, which `AutoModel` loads once those configs
 * are cleared.
 */
export function isMultimodalEncoderConfig(config: Record<string, unknown>): boolean {
  return Boolean(config.vision_config || config.audio_config);
}

/** How many external-data sidecars the profile pins beside its graph (`<graph>_data`, `<graph>_data_1`, …). */
export function pinnedExternalDataChunks(profile: KnowledgeEmbeddingProfile): number {
  const { onnxFile, files } = embeddingProfileArtifacts(profile);
  const prefix = `${onnxFile}_data`;
  return files.filter((f) => f.path === prefix || /^_\d+$/.test(f.path.slice(prefix.length)))
    .length;
}

/**
 * The model's raw output rows from an encoder run: the graph's own
 * `sentence_embedding` when it has one (pooling inside the graph), else the
 * attention-masked mean of `last_hidden_state`.
 */
function encoderRows(
  outputs: Record<string, TensorLike>,
  attentionMask: TensorLike | undefined,
): number[][] {
  const pooled = outputs.sentence_embedding;
  if (pooled) {
    const [batch = 0, width = 0] = pooled.dims;
    return Array.from({ length: batch }, (_, b) =>
      Array.from({ length: width }, (_, d) => pooled.data[b * width + d] as number),
    );
  }
  const hidden = outputs.last_hidden_state;
  if (!hidden || !attentionMask) {
    throw new Error('the encoder returned neither sentence_embedding nor last_hidden_state');
  }
  const [batch = 0, tokens = 0, width = 0] = hidden.dims;
  return Array.from({ length: batch }, (_, b) => {
    const sum = new Array<number>(width).fill(0);
    let count = 0;
    for (let t = 0; t < tokens; t++) {
      if (!Number(attentionMask.data[b * tokens + t])) continue;
      count++;
      const base = (b * tokens + t) * width;
      for (let d = 0; d < width; d++)
        sum[d] = (sum[d] as number) + (hidden.data[base + d] as number);
    }
    return sum.map((v) => v / Math.max(1, count));
  });
}

async function loadTransformers(): Promise<TransformersModule> {
  try {
    const specifier = '@huggingface/transformers';
    return (await import(specifier)) as unknown as TransformersModule;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Cannot find (module|package)/i.test(message)) {
      throw new EmbedderUnavailableError(
        `the embedding runtime is not installed — knowledge builds and semantic search need the optional peer @huggingface/transformers@${TRANSFORMERS_PEER_RANGE}; install it alongside @bendyline/gezel-knowledge`,
        { runtimeMissing: true },
      );
    }
    throw err;
  }
}

/**
 * Make a load of a profile with weight sidecars safe from transformers.js's
 * sidecar hang (see pinned-files.ts): a local-only load fails fast, naming
 * the files that are missing; a networked load downloads the sidecars first,
 * hash-verified. A profile without sidecars loads exactly as before.
 */
export async function preparePinnedLoad(
  profile: KnowledgeEmbeddingProfile,
  opts: {
    cacheDir: string;
    localFilesOnly?: boolean;
    modalities?: ReadonlyArray<'image' | 'video' | 'audio'>;
    fetchImpl?: typeof fetch;
  },
): Promise<void> {
  const files = pinnedLoadFiles(profile, opts.modalities);
  if (!files.some((f) => isExternalDataFile(f.path))) return;
  if (opts.localFilesOnly) {
    const missing = await missingPinnedFiles(profile, opts);
    if (missing.length > 0) {
      throw new EmbedderUnavailableError(
        `the model files for profile ${profile.id} are not all installed (missing: ${missing.join(', ')})`,
      );
    }
    return;
  }
  await prefetchExternalData(profile, opts);
}

export async function createProfileEmbedder(
  profile: KnowledgeEmbeddingProfile,
  opts: {
    cacheDir?: string;
    /** Read cached model files only; never initiate a download. */
    localFilesOnly?: boolean;
    /**
     * onnxruntime session options (e.g. `{ intraOpNumThreads }`), passed
     * through to the pipeline. Worker pools use this to divide cores between
     * concurrent sessions instead of letting every session grab them all.
     * Thread counts change scheduling, never numerics — batch composition is
     * what affects values, and that stays with the caller.
     */
    sessionOptions?: Record<string, unknown>;
    /** Called as the model and tokenizer files download. */
    onDownloadProgress?: (progress: ModelDownloadProgress) => void;
    /** Test seam: a stand-in for `@huggingface/transformers`. */
    transformers?: TransformersModule;
  } = {},
): Promise<ProfileEmbedder> {
  const pooling = POOLING_BY_PROFILE[profile.pooling];
  if (!pooling) {
    throw new EmbedderUnavailableError(
      `profile ${profile.id} uses ${profile.pooling} pooling, which this runtime does not implement`,
    );
  }
  const modelOptions = resolveTransformersModelOptions(profile);
  const transformers = opts.transformers ?? (await loadTransformers());
  const cacheDir = opts.cacheDir ?? process.env.GEZEL_HF_CACHE_DIR;
  if (cacheDir) {
    transformers.env.cacheDir = cacheDir;
    transformers.env.useFSCache = true;
    transformers.env.allowRemoteModels = true;
  }
  const progress = opts.onDownloadProgress
    ? { progress_callback: aggregateDownloadProgress(opts.onDownloadProgress) }
    : {};
  const localOnly = opts.localFilesOnly ? { local_files_only: true } : {};
  if (!opts.transformers) {
    await preparePinnedLoad(profile, {
      cacheDir: cacheDir ?? transformers.env.cacheDir ?? '',
      ...(opts.localFilesOnly ? { localFilesOnly: true } : {}),
    });
  }
  const sessionOptions = opts.sessionOptions ? { session_options: opts.sessionOptions } : {};
  const config = transformers.AutoConfig
    ? await transformers.AutoConfig.from_pretrained(profile.model.repo, {
        revision: modelOptions.revision,
        ...localOnly,
        ...progress,
      })
    : null;
  const multimodal = config !== null && isMultimodalEncoderConfig(config);
  if (multimodal && !transformers.AutoModel) {
    throw new EmbedderUnavailableError(
      `profile ${profile.id} is a multimodal encoder; this runtime cannot load its text session`,
    );
  }
  const externalData = pinnedExternalDataChunks(profile);
  const [runner, tokenizer] = await Promise.all([
    multimodal
      ? (transformers.AutoModel as NonNullable<TransformersModule['AutoModel']>).from_pretrained(
          profile.model.repo,
          {
            ...modelOptions,
            config: { ...config, vision_config: null, audio_config: null },
            ...(externalData > 0 ? { use_external_data_format: externalData } : {}),
            ...localOnly,
            ...sessionOptions,
            ...progress,
          },
        )
      : transformers.pipeline('feature-extraction', profile.model.repo, {
          ...modelOptions,
          ...(externalData > 0 ? { use_external_data_format: externalData } : {}),
          ...localOnly,
          ...sessionOptions,
          ...progress,
        }),
    transformers.AutoTokenizer.from_pretrained(profile.model.repo, {
      revision: modelOptions.revision,
      ...localOnly,
      ...progress,
    }),
  ]);

  let verification: VerifiedArtifacts;
  try {
    verification = await verifyProfileArtifacts(profile, {
      cacheDir: cacheDir ?? transformers.env.cacheDir ?? '',
    });
  } catch (err) {
    await runner.dispose?.().catch(() => {});
    throw err;
  }

  const cap = (text: string): string =>
    text.length <= MAX_CHARS ? text : text.slice(0, MAX_CHARS);

  const runBatch = multimodal
    ? async (slice: string[]): Promise<number[][]> => {
        const inputs = (tokenizer as BatchTokenizerFn)(slice, {
          padding: true,
          truncation: true,
          max_length: profile.maxTokens,
        });
        return encoderRows(await (runner as EncoderModelFn)(inputs), inputs.attention_mask);
      }
    : async (slice: string[]): Promise<number[][]> =>
        (await (runner as PipelineFn)(slice, { pooling, normalize: true })).tolist();

  const embed = async (texts: string[]): Promise<number[][]> => {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      out.push(...(await runBatch(texts.slice(i, i + MAX_BATCH).map(cap))));
    }
    return out;
  };

  return {
    profile,
    verification,
    embed,
    embedQuery: async (text) => {
      const [vector] = await embed([`${profile.queryInstruction}${text}`]);
      if (!vector) throw new Error(`profile ${profile.id} returned no query vector`);
      return profileUnitVector(profile, vector);
    },
    countTokens: (text) => tokenizer.encode(text).length,
    dispose: async () => {
      await runner.dispose?.();
    },
  };
}
