/**
 * Profile-conformant embedder + tokenizer, driven entirely by a declarative
 * KnowledgeEmbeddingProfile — model repo, pinned revision, pooling, and
 * instruction prefixes all come from the profile object, never from env-var
 * regexes. This is what the offline CLI wires into the compiler and the
 * explicit-search path; the daemon wires its own pipeline pool later.
 *
 * `@huggingface/transformers` stays a dynamic import (mirroring the
 * service's embed-core): the CLI must start instantly without it, and a
 * missing module surfaces as an actionable install message, not an
 * ERR_MODULE_NOT_FOUND. Honors GEZEL_HF_CACHE_DIR so CLI builds share the
 * daemon's model cache.
 */

import type { KnowledgeEmbeddingProfile } from '@bendyline/gezel';

const MAX_BATCH = 8;
const MAX_CHARS = 8_000;

export interface ProfileEmbedder {
  readonly profile: KnowledgeEmbeddingProfile;
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

interface TransformersModule {
  pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<PipelineFn>;
  AutoTokenizer: {
    from_pretrained: (model: string, options?: Record<string, unknown>) => Promise<TokenizerFn>;
  };
  env: { cacheDir?: string; useFSCache?: boolean; allowRemoteModels?: boolean };
}

type PipelineFn = ((
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>) & { dispose?: () => Promise<void> };

interface TokenizerFn {
  encode(text: string): number[];
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
  } = {},
): Promise<ProfileEmbedder> {
  const transformers = await loadTransformers();
  const cacheDir = opts.cacheDir ?? process.env.GEZEL_HF_CACHE_DIR;
  if (cacheDir) {
    transformers.env.cacheDir = cacheDir;
    transformers.env.useFSCache = true;
    transformers.env.allowRemoteModels = true;
  }
  const modelOpts = {
    revision: profile.model.revision,
    ...(opts.sessionOptions ? { session_options: opts.sessionOptions } : {}),
  };
  const [pipe, tokenizer] = await Promise.all([
    transformers.pipeline('feature-extraction', profile.model.repo, modelOpts),
    transformers.AutoTokenizer.from_pretrained(profile.model.repo, modelOpts),
  ]);

  const cap = (text: string): string =>
    text.length <= MAX_CHARS ? text : text.slice(0, MAX_CHARS);

  const embed = async (texts: string[]): Promise<number[][]> => {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const slice = texts.slice(i, i + MAX_BATCH).map(cap);
      const result = await pipe(slice, { pooling: 'mean', normalize: true });
      out.push(...result.tolist());
    }
    return out;
  };

  return {
    profile,
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
