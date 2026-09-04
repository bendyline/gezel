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

import { type KnowledgeEmbeddingProfile, embeddingProfileArtifacts } from '@bendyline/gezk';
import { type VerifiedArtifacts, verifyProfileArtifacts } from './artifact-verify.js';

const MAX_BATCH = 8;
const MAX_CHARS = 8_000;

export interface ProfileEmbedder {
  readonly profile: KnowledgeEmbeddingProfile;
  /** What the loaded model files were checked against after loading. */
  readonly verification: VerifiedArtifacts;
  /** Raw passage embed — takes ALREADY-PREFIXED texts (the compiler's contract). */
  embed(texts: string[]): Promise<number[][]>;
  /** Query embed — applies the profile's queryInstruction itself. */
  embedQuery(text: string): Promise<Float32Array>;
  /** Profile-tokenizer token count (sync once loaded — chunking's contract). */
  countTokens(text: string): number;
  dispose(): Promise<void>;
}

export class EmbedderUnavailableError extends Error {
  readonly isActionable = true;
  constructor(message: string) {
    super(message);
    this.name = 'EmbedderUnavailableError';
  }
}

/** The slice of `@huggingface/transformers` this module drives; injectable for tests. */
export interface TransformersModule {
  pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<PipelineFn>;
  AutoTokenizer: {
    from_pretrained: (model: string, options?: Record<string, unknown>) => Promise<TokenizerFn>;
  };
  env: { cacheDir?: string; useFSCache?: boolean; allowRemoteModels?: boolean };
}

export type PipelineFn = ((
  texts: string[],
  options: { pooling: string; normalize: boolean },
) => Promise<{ tolist(): number[][] }>) & { dispose?: () => Promise<void> };

export interface TokenizerFn {
  encode(text: string): number[];
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
  if (!onnxFile.endsWith('.onnx')) {
    throw new EmbedderUnavailableError(
      `profile ${profile.id} pins ${onnxFile}; this runtime loads ONNX graphs only`,
    );
  }
  const slash = onnxFile.lastIndexOf('/');
  const subfolder = slash === -1 ? '' : onnxFile.slice(0, slash);
  const base = onnxFile.slice(slash + 1, -'.onnx'.length);
  const variant = ONNX_DTYPE_BY_SUFFIX.find(([suffix]) => base.endsWith(suffix));
  const [suffix, dtype] = variant ?? ['', 'fp32'];
  const modelFileName = base.slice(0, base.length - suffix.length);
  if (modelFileName === '') {
    throw new EmbedderUnavailableError(`profile ${profile.id} pins an unnamed graph ${onnxFile}`);
  }
  return { revision: profile.model.revision, dtype, subfolder, model_file_name: modelFileName };
}

async function loadTransformers(): Promise<TransformersModule> {
  try {
    const specifier = '@huggingface/transformers';
    return (await import(specifier)) as unknown as TransformersModule;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Cannot find (module|package)/i.test(message)) {
      throw new EmbedderUnavailableError(
        'the embedding runtime (@huggingface/transformers) is not installed — knowledge builds and semantic search need it; install it or run inside a gezel install that ships it',
      );
    }
    throw err;
  }
}

export async function createProfileEmbedder(
  profile: KnowledgeEmbeddingProfile,
  opts: {
    cacheDir?: string;
    /**
     * onnxruntime session options (e.g. `{ intraOpNumThreads }`), passed
     * through to the pipeline. Worker pools use this to divide cores between
     * concurrent sessions instead of letting every session grab them all.
     * Thread counts change scheduling, never numerics — batch composition is
     * what affects values, and that stays with the caller.
     */
    sessionOptions?: Record<string, unknown>;
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
  const [pipe, tokenizer] = await Promise.all([
    transformers.pipeline('feature-extraction', profile.model.repo, {
      ...modelOptions,
      ...(opts.sessionOptions ? { session_options: opts.sessionOptions } : {}),
    }),
    transformers.AutoTokenizer.from_pretrained(profile.model.repo, {
      revision: modelOptions.revision,
    }),
  ]);

  let verification: VerifiedArtifacts;
  try {
    verification = await verifyProfileArtifacts(profile, {
      cacheDir: cacheDir ?? transformers.env.cacheDir ?? '',
    });
  } catch (err) {
    await pipe.dispose?.().catch(() => {});
    throw err;
  }

  const cap = (text: string): string =>
    text.length <= MAX_CHARS ? text : text.slice(0, MAX_CHARS);

  const embed = async (texts: string[]): Promise<number[][]> => {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const slice = texts.slice(i, i + MAX_BATCH).map(cap);
      const result = await pipe(slice, { pooling, normalize: true });
      out.push(...result.tolist());
    }
    return out;
  };

  return {
    profile,
    verification,
    embed,
    embedQuery: async (text) => {
      const [vector] = await embed([`${profile.queryInstruction}${text}`]);
      return Float32Array.from(vector ?? []);
    },
    countTokens: (text) => tokenizer.encode(text).length,
    dispose: async () => {
      await pipe.dispose?.();
    },
  };
}
