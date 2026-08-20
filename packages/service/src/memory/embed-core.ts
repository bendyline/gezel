/**
 * Core embedding inference, shared by the worker-thread host and the
 * in-process fallback (see embeddings.ts). Loads the transformers.js
 * feature-extraction pipeline (all-MiniLM-L6-v2, 384-dim) lazily and runs it
 * in BOUNDED sub-batches.
 *
 * The sub-batching is the fix for the crash that took down the Electron main
 * process: `enrichFile` embeds every chunk of a file in one call, and a large
 * doc produces hundreds of chunks. transformers.js pads the whole batch to its
 * longest sequence and hands ONNX a single tensor whose size scales with the
 * batch, so a many-chunk file triggered a multi-gigabyte allocation in
 * `onnxruntime::BFCArena::Extend` → `posix_memalign` → SIGTRAP. Capping the
 * batch bounds peak allocation regardless of how many texts a caller passes.
 */

import { createLogger } from '@bendyline/gezel';
import {
  HF_CACHE_DIR_ENV,
  TRANSFORMERS_MODULE,
  isMissingModule,
  pinTransformersCacheDir,
} from '../transformers-cache.js';

export const log = createLogger('memory');

/**
 * Max texts handed to a single ONNX `Run`. The sub-batch is padded to its
 * longest sequence (≤ the model's 512-token window), so peak transient memory
 * is ~MAX_BATCH × 512² × heads × 4B. 8 keeps that comfortably under ~150 MB no
 * matter how many chunks a file produces. Sub-batching does not change the
 * per-text output — mean-pooling + normalize are per-text and attention masks
 * ignore padding — so vectors are bit-identical to a single big batch.
 */
const MAX_BATCH = 8;

/**
 * Hard char cap per text before tokenization. The tokenizer already truncates
 * to the model's 512-token window, but a pathologically large chunk (e.g. a
 * minified blob that slipped past the indexer's 4 KB-per-chunk cap) would still
 * cost O(n) just to tokenize. 8 KB ≈ 2 K tokens, well above the 512 the model
 * keeps, so this only ever trims genuine outliers.
 */
const MAX_CHARS = 8_000;

/**
 * Feature-extraction model. Default bge-small-en-v1.5 (384-dim) — the
 * index-bench embedding A/B measured it at semantic recall@5 75% vs MiniLM-L6's
 * 50% on the squisq corpus (evals/runs/INDEX-BENCH-2026-07-06.md). Overridable
 * via `GEZEL_EMBED_MODEL`; any transformers.js feature-extraction model works.
 * A same-dim swap (MiniLM, gte-small, bge-small are all 384) is a pure drop-in;
 * a different dim needs `GEZEL_EMBED_DIM` set. Existing indexes stamp the
 * embedder and re-embed on a model change (content: IndexStore.open's
 * `reconcileEmbedModel`; memory: MemoryHealthMonitor via the mem_meta stamp) —
 * they're regenerable caches, so the cutover costs a one-time re-embed (no
 * re-summarize; enrichFile reuses stored summaries).
 */
const DEFAULT_EMBED_MODEL = 'Xenova/bge-small-en-v1.5';

export function embedModelId(): string {
  return process.env.GEZEL_EMBED_MODEL || DEFAULT_EMBED_MODEL;
}

/**
 * Asymmetric-retrieval query prefix. The bge-* family was trained with a
 * query-side instruction ("Represent this sentence for searching relevant
 * passages:") prepended to the *query* only — passages (the indexed chunks)
 * get none. Applying it lifts retrieval on the model's own benchmark; our
 * initial bge promotion measured recall WITHOUT it, so this is pure upside on
 * top. Returns '' for models that weren't trained this way (MiniLM, gte-small
 * are symmetric) so `embed`/`embedQuery` collapse to identical behavior there.
 * `GEZEL_EMBED_NO_QUERY_INSTRUCTION=1` disables it for A/B isolation.
 */
export function queryInstruction(): string {
  if (process.env.GEZEL_EMBED_NO_QUERY_INSTRUCTION === '1') return '';
  const model = embedModelId();
  if (/bge-/i.test(model)) return 'Represent this sentence for searching relevant passages: ';
  // The e5 family (incl. multilingual-e5-*) is trained with BOTH sides
  // prefixed — "query: " / "passage: " — and measurably underperforms
  // without them (its model card calls unprefixed use an error).
  if (/(^|\/|-)e5-/i.test(model) || /multilingual-e5/i.test(model)) return 'query: ';
  return '';
}

/**
 * Passage-side counterpart to {@link queryInstruction}. Empty for every
 * model family except e5, whose training prefixes BOTH sides; bge prefixes
 * only queries, and symmetric models (MiniLM, gte) prefix nothing — so the
 * default install's behavior is unchanged by this hook existing.
 */
export function passageInstruction(): string {
  if (process.env.GEZEL_EMBED_NO_QUERY_INSTRUCTION === '1') return '';
  const model = embedModelId();
  if (/(^|\/|-)e5-/i.test(model) || /multilingual-e5/i.test(model)) return 'passage: ';
  return '';
}

type Pipeline = (
  texts: string[],
  opts?: { pooling: string; normalize: boolean },
) => Promise<{ tolist: () => number[][] }>;

/**
 * Thrown when the model itself can't be loaded. Distinguished from a transient
 * inference error so the host can permanently disable embeddings rather than
 * retry the full failure on every chunk.
 */
export class PipelineLoadError extends Error {
  readonly code = 'PIPELINE_LOAD_FAILED';
  /**
   * The optional peer is simply not installed — a documented, supported npm
   * configuration. Callers use this to degrade quietly instead of reporting a
   * damaged runtime.
   */
  readonly optionalPeerMissing: boolean;
  /**
   * Network/model-registry failures can clear without a process restart. The
   * host uses this bit to apply a short retry cooldown instead of permanently
   * disabling embeddings after one failed first-use download.
   */
  readonly retryable: boolean;
  constructor(message: string, optionalPeerMissing = false, retryable = false) {
    super(message);
    this.name = 'PipelineLoadError';
    this.optionalPeerMissing = optionalPeerMissing;
    this.retryable = retryable;
  }
}

/**
 * Keep the retry classification deliberately narrow. Bad model ids, missing
 * native libraries, and incompatible runtimes need operator action; transport
 * failures and registry throttling commonly recover on their own.
 *
 * The undici mid-stream abort family (`terminated`, `other side closed`,
 * `premature close`, `aborted`) is here because its absence was a wild-caught
 * product bug: a model download killed at ~103s surfaced as a bare
 * `TypeError: terminated`, classified FATAL, and stickily disabled semantic
 * search for the daemon's lifetime — silently, since search degrades to
 * keyword instead of erroring (evals/runs/EMBED-CALIBRATION-2026-08-19.md).
 */
export function isRetryablePipelineLoadFailure(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code ?? '';
  return /(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_|ERR_STREAM_PREMATURE_CLOSE|fetch failed|network(?: request)? failed|socket hang up|timed?\s*out|terminated|other side closed|premature close|aborted|HTTP\s+(?:408|425|429|5\d\d)|TLS|SSL|certificate)/i.test(
    `${code} ${message}`,
  );
}

let pipelinePromise: Promise<Pipeline> | null = null;

/** Lazily create the feature-extraction pipeline; cached for the process. */
export async function loadPipeline(): Promise<Pipeline> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      try {
        // Pin transformers.js to gezel's writable managed cache dir before
        // the first load. Without it, a bundled runtime's default (module-
        // relative, read-only) cache makes the model download fail to cache
        // and throws "Unable to get model file path or buffer". The dir is
        // passed via env so this works in the embed worker thread too, which
        // inherits `process.env` but has no other view of the gezel home.
        const cacheDir = process.env[HF_CACHE_DIR_ENV];
        if (cacheDir) await pinTransformersCacheDir(cacheDir);
        const { pipeline } = await import('@huggingface/transformers');
        const modelId = embedModelId();
        if (modelId !== DEFAULT_EMBED_MODEL) log.info(`[embed] using model ${modelId}`);
        return (await pipeline('feature-extraction', modelId)) as Pipeline;
      } catch (err) {
        const missing = isMissingModule(err, TRANSFORMERS_MODULE);
        const message = missing
          ? 'Local memory embeddings are an optional npm feature. Install @huggingface/transformers@^3.8.1 alongside @bendyline/gezel-service (see the service README).'
          : err instanceof Error
            ? err.message
            : String(err);
        throw new PipelineLoadError(
          message,
          missing,
          !missing && isRetryablePipelineLoadFailure(err),
        );
      }
    })();
    // A transient load failure (e.g. network blip during the first download)
    // shouldn't wedge the process forever — drop the rejected promise so a
    // later call can retry. Permanent failures are made sticky by the host.
    pipelinePromise.catch(() => {
      pipelinePromise = null;
    });
  }
  return pipelinePromise;
}

/**
 * Embed `texts` into 384-dim unit vectors — one per input, order-preserving.
 * Runs in sub-batches of at most MAX_BATCH so peak ONNX allocation stays
 * bounded no matter how many texts are passed in one call.
 */
export async function runEmbed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const pipe = await loadPipeline();
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const slice = texts.slice(i, i + MAX_BATCH).map(capText);
    const result = await pipe(slice, { pooling: 'mean', normalize: true });
    for (const v of result.tolist()) out.push(v);
  }
  return out;
}

/** Bound a single text's length, and stand in for an empty string. */
function capText(s: string): string {
  // The tokenizer is unhappy with an empty string inside a padded batch; a
  // single space is a near-zero-cost stand-in that still yields a valid vector
  // (callers get a deterministic vector back rather than a thrown batch).
  if (!s) return ' ';
  return s.length > MAX_CHARS ? s.slice(0, MAX_CHARS) : s;
}
