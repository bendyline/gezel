/**
 * Whole-image embedding core (lane A of image search). Sibling of
 * embed-core.ts: same lazy transformers.js loading, same HF cache pin, but a
 * CLIP vision tower instead of a text feature-extraction pipeline, and pure-JS
 * decode/preprocess (image-pixels.ts) instead of sharp — which gezel
 * deliberately stubs out (packages/sharp-compat), making transformers' own
 * RawImage/AutoProcessor path unusable. Runs in the image-embed worker thread
 * or the in-process fallback (image-embeddings.ts).
 *
 * Two deliberate deviations from the `pipeline('image-feature-extraction')`
 * convenience API, both load-bearing:
 *   - The model is loaded via its concrete vision class and read through
 *     `.image_embeds` — the pipeline's default output selection prefers
 *     `last_hidden_state`, which for a CLIP export silently returns the
 *     UNPOOLED patch grid instead of the 512-d projection.
 *   - Vectors are L2-normalized HERE: transformers does not normalize
 *     `image_embeds`, and every stored-vector consumer (cosine helper,
 *     brute-force ranking) assumes unit vectors.
 */

import { readFile } from 'node:fs/promises';
import { createLogger } from '@bendyline/gezel';
import {
  HF_CACHE_DIR_ENV,
  TRANSFORMERS_MODULE,
  isMissingModule,
  pinTransformersCacheDir,
} from '../transformers-cache.js';
import { PipelineLoadError, isRetryablePipelineLoadFailure } from './embed-core.js';
import {
  CLIP_MEAN,
  CLIP_STD,
  ImageDecodeError,
  centerCrop,
  decodeImage,
  normalizeToCHW,
  resizeBilinear,
  resizeShortestSide,
  rgbaToRgb,
} from './image-pixels.js';

const log = createLogger('memory');

const DEFAULT_IMAGE_EMBED_MODEL = 'Xenova/clip-vit-base-patch32';

export function imageEmbedModelId(): string {
  return process.env.GEZEL_IMAGE_EMBED_MODEL || DEFAULT_IMAGE_EMBED_MODEL;
}

/**
 * Output dimension of the image embedder (CLIP ViT-B/32 projection = 512).
 * `GEZEL_IMAGE_EMBED_DIM` must accompany a non-default model with a different
 * projection width. Stored vectors carry their dim, so a mismatch is detected
 * at query time rather than producing garbage cosine.
 */
export function imageEmbedDim(): number {
  return Number(process.env.GEZEL_IMAGE_EMBED_DIM) || 512;
}

/** Model input edge (224 for every ViT-B CLIP checkpoint). */
function imageEmbedSize(): number {
  return Number(process.env.GEZEL_IMAGE_EMBED_SIZE) || 224;
}

/**
 * Weight precision. q8 cuts the default model's download from ~350 MB to
 * ~88 MB with negligible effect on nearest-neighbor ranking. An override
 * model without quantized weights needs `GEZEL_IMAGE_EMBED_DTYPE=fp32`.
 */
function imageEmbedDtype(): string {
  return process.env.GEZEL_IMAGE_EMBED_DTYPE || 'q8';
}

/** One image handed to the embedder: absolute path + its content hash. */
export interface ImageEmbedJob {
  path: string;
  hash: string;
}

/**
 * Per-image outcome. `skip` reasons are TERMINAL for that content hash (the
 * gate marks them unsupported — a changed file is a new hash); `error` is
 * retryable (transient fs trouble). Pipeline-level failures (model unloadable)
 * throw {@link PipelineLoadError} for the whole batch instead.
 */
export type ImageEmbedOutcome =
  | { hash: string; vector: number[] }
  | { hash: string; skip: 'unsupported' | 'too-large' | 'decode-failed'; detail?: string }
  | { hash: string; error: string };

type VisionModel = (inputs: { pixel_values: unknown }) => Promise<{
  image_embeds?: { data: Float32Array | number[] };
  pooler_output?: { data: Float32Array | number[] };
}>;

interface LoadedVision {
  model: VisionModel;
  makeTensor: (data: Float32Array, dims: number[]) => unknown;
}

let visionPromise: Promise<LoadedVision> | null = null;

/** Lazily load the vision model; cached for the process (same discipline as loadPipeline). */
async function loadVisionModel(): Promise<LoadedVision> {
  if (!visionPromise) {
    visionPromise = (async () => {
      try {
        const cacheDir = process.env[HF_CACHE_DIR_ENV];
        if (cacheDir) await pinTransformersCacheDir(cacheDir);
        const transformers = await import('@huggingface/transformers');
        const modelId = imageEmbedModelId();
        if (modelId !== DEFAULT_IMAGE_EMBED_MODEL) log.info(`[image-embed] using model ${modelId}`);
        // AutoModelForImageFeatureExtraction maps clip → the vision tower +
        // projection (no text tower download), siglip → SiglipVisionModel.
        const auto = (
          transformers as unknown as {
            AutoModelForImageFeatureExtraction: {
              from_pretrained: (id: string, opts: { dtype: string }) => Promise<VisionModel>;
            };
          }
        ).AutoModelForImageFeatureExtraction;
        const model = await auto.from_pretrained(modelId, { dtype: imageEmbedDtype() });
        const TensorCtor = (
          transformers as unknown as {
            Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
          }
        ).Tensor;
        return {
          model,
          makeTensor: (data, dims) => new TensorCtor('float32', data, dims),
        };
      } catch (err) {
        const missing = isMissingModule(err, TRANSFORMERS_MODULE);
        const message = missing
          ? 'Local image embeddings are an optional npm feature. Install @huggingface/transformers@^3.8.1 alongside @bendyline/gezel-service (see the service README).'
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
    visionPromise.catch(() => {
      visionPromise = null;
    });
  }
  return visionPromise;
}

/**
 * Preprocess one decoded buffer for the current model. CLIP reference geometry
 * (shortest-side resize + center-crop, CLIP mean/std); SigLIP overrides get
 * their convention (squash to square, mean/std 0.5) keyed off the model id.
 */
function preprocess(buf: Buffer, size: number): Float32Array {
  const rgb = rgbaToRgb(decodeImage(buf));
  if (/siglip/i.test(imageEmbedModelId())) {
    const HALF = [0.5, 0.5, 0.5];
    return normalizeToCHW(resizeBilinear(rgb, size, size), HALF, HALF);
  }
  return normalizeToCHW(centerCrop(resizeShortestSide(rgb, size), size, size));
}

function l2Normalize(data: Float32Array | number[]): number[] {
  let sum = 0;
  for (const v of data) sum += v * v;
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) throw new Error('degenerate embedding (zero norm)');
  const out = new Array<number>(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i]! / norm;
  return out;
}

/**
 * Embed a batch of image files into unit vectors — SERIAL, one fixed-size
 * [1, 3, size, size] forward at a time, so peak ONNX allocation is one image
 * (the vision-tower analogue of embed-core's MAX_BATCH discipline).
 */
export async function runImageEmbed(jobs: ImageEmbedJob[]): Promise<ImageEmbedOutcome[]> {
  if (jobs.length === 0) return [];
  const { model, makeTensor } = await loadVisionModel();
  const size = imageEmbedSize();
  const out: ImageEmbedOutcome[] = [];
  for (const job of jobs) {
    let buf: Buffer;
    try {
      buf = await readFile(job.path);
    } catch (err) {
      out.push({ hash: job.hash, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    try {
      const chw = preprocess(buf, size);
      const result = await model({ pixel_values: makeTensor(chw, [1, 3, size, size]) });
      const embeds = result.image_embeds ?? result.pooler_output;
      if (!embeds) throw new Error('model returned neither image_embeds nor pooler_output');
      out.push({ hash: job.hash, vector: l2Normalize(embeds.data) });
    } catch (err) {
      if (err instanceof ImageDecodeError) {
        out.push({ hash: job.hash, skip: err.reason, detail: err.message });
      } else {
        out.push({ hash: job.hash, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return out;
}
