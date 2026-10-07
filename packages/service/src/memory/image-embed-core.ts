/**
 * Whole-image embedding core (lane A of image search): EmbeddingGemma 2's
 * vision path through the media-search profile, so a workspace image lands in
 * the same space as text queries (search by meaning) and as the media rows of
 * knowledge catalogs. Runs in the image-embed worker thread or the in-process
 * fallback (image-embeddings.ts).
 *
 * The model loads from local files only: the media-search installer
 * (media-search/install.ts) is the one place that downloads, gated on the
 * security policy, so an index pass can never start a 500 MB fetch.
 */

import { createLogger } from '@bendyline/gezel';
import { profileUnitVector } from '@bendyline/gezel-knowledge';
import { MEDIA_SEARCH_PROFILE } from '../media-search/profile.js';
import { HF_CACHE_DIR_ENV, TRANSFORMERS_MODULE, isMissingModule } from '../transformers-cache.js';
import { PipelineLoadError, isRetryablePipelineLoadFailure } from './embed-core.js';
import { ImageDecodeError, decodeImage, readBoundedImageFile, rgbaToRgb } from './image-pixels.js';
import { type MediaEncoder, type MediaModality, loadMediaEncoder } from './media-embed-core.js';

const log = createLogger('memory');

/** The vision token budgets the Gemma 4 image processor supports. */
export const IMAGE_TOKEN_BUDGETS = [70, 140, 280, 560, 1120] as const;

/**
 * Vision tokens per workspace image: `GEZEL_MEDIA_IMAGE_TOKEN_BUDGET` (set
 * from `config.mediaSearch.imageTokenBudget`), else the profile's 280 — the
 * same fidelity catalogs embed at, so the two sets of vectors compare.
 */
export function imageTokenBudget(): number {
  const raw = Number(process.env.GEZEL_MEDIA_IMAGE_TOKEN_BUDGET);
  return (IMAGE_TOKEN_BUDGETS as readonly number[]).includes(raw)
    ? raw
    : (MEDIA_SEARCH_PROFILE.media?.image?.tokenBudget ?? 280);
}

/**
 * The identity stored vectors are keyed on: profile, modality and budget. A
 * budget change moves every image vector, so it must invalidate them like a
 * model change does (index-store's reconcileImageEmbedModel).
 */
export function imageEmbedModelId(budget = imageTokenBudget()): string {
  return `${MEDIA_SEARCH_PROFILE.id}#image@${budget}`;
}

/** Stored width: the profile's truncated dimension. */
export function imageEmbedDim(): number {
  return MEDIA_SEARCH_PROFILE.dimensions;
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

const encoders = new Map<string, Promise<MediaEncoder>>();

/** Lazily load the media encoder for these modalities and budget; cached for the process. */
export async function loadWorkspaceMediaEncoder(
  modalities: readonly MediaModality[],
  budget = imageTokenBudget(),
): Promise<MediaEncoder> {
  const key = `${[...modalities].sort().join('+')}@${budget}`;
  let pending = encoders.get(key);
  if (!pending) {
    pending = (async () => {
      try {
        const encoder = await loadMediaEncoder(MEDIA_SEARCH_PROFILE, {
          modalities,
          localFilesOnly: true,
          imageTokenBudget: budget,
          ...(process.env[HF_CACHE_DIR_ENV] ? { cacheDir: process.env[HF_CACHE_DIR_ENV] } : {}),
        });
        log.info(`[media-embed] loaded ${MEDIA_SEARCH_PROFILE.id} (${key})`);
        return encoder;
      } catch (err) {
        const missing = isMissingModule(err, TRANSFORMERS_MODULE);
        const message = missing
          ? 'Local media embeddings are an optional npm feature. Install @huggingface/transformers@^4.3.1 alongside @bendyline/gezel-service (see the service README).'
          : err instanceof Error
            ? err.message
            : String(err);
        // Not installed yet is the common case: retry after the cooldown, once
        // the installer has had a chance to finish.
        throw new PipelineLoadError(
          message,
          missing,
          !missing || isRetryablePipelineLoadFailure(err),
        );
      }
    })();
    pending.catch(() => encoders.delete(key));
    encoders.set(key, pending);
  }
  return pending;
}

/** Drop loaded encoders (the model was removed or reinstalled). */
export async function disposeWorkspaceMediaEncoders(): Promise<void> {
  const loaded = [...encoders.values()];
  encoders.clear();
  for (const pending of loaded) await pending.then((e) => e.dispose()).catch(() => {});
}

/**
 * Embed a batch of image files into unit vectors — SERIAL, one image per
 * forward, so peak ONNX allocation is one image.
 */
export async function runImageEmbed(
  jobs: ImageEmbedJob[],
  budget = imageTokenBudget(),
): Promise<ImageEmbedOutcome[]> {
  if (jobs.length === 0) return [];
  const encoder = await loadWorkspaceMediaEncoder(['image'], budget);
  const out: ImageEmbedOutcome[] = [];
  for (const job of jobs) {
    try {
      const rgb = rgbaToRgb(decodeImage(await readBoundedImageFile(job.path)));
      const raw = await encoder.embedImage(rgb);
      out.push({
        hash: job.hash,
        vector: Array.from(profileUnitVector(MEDIA_SEARCH_PROFILE, raw)),
      });
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

/** One audio or video file for the media tier: absolute path, content hash, kind. */
export interface MediaEmbedJob {
  path: string;
  hash: string;
  modality: 'audio' | 'video';
}

/** Per-file outcome: every window's unit vector, or the same skip/error split as images. */
export type MediaEmbedOutcome =
  | { hash: string; windows: Array<{ startMs: number; endMs: number; vector: number[] }> }
  | { hash: string; skip: 'unsupported' | 'decode-failed'; detail?: string }
  | { hash: string; error: string };

/**
 * Embed audio and video files window by window: ffmpeg cuts them (media/
 * segment.ts) and each window becomes one unit vector. Serial, one window
 * per forward.
 */
export async function runMediaEmbed(
  jobs: MediaEmbedJob[],
  budget = imageTokenBudget(),
): Promise<MediaEmbedOutcome[]> {
  if (jobs.length === 0) return [];
  const { locateFfmpeg } = await import('../media/ffmpeg.js');
  const { decodeAudioWindows, decodeVideoWindows } = await import('../media/segment.js');
  const ffmpeg = await locateFfmpeg();
  if (!ffmpeg) {
    throw new PipelineLoadError('no ffmpeg found for video and audio indexing', false, true);
  }
  const out: MediaEmbedOutcome[] = [];
  for (const job of jobs) {
    try {
      const windows: Array<{ startMs: number; endMs: number; vector: number[] }> = [];
      if (job.modality === 'audio') {
        const decoded = await decodeAudioWindows(ffmpeg.path, job.path, MEDIA_SEARCH_PROFILE);
        if (decoded.length > 0) {
          const encoder = await loadWorkspaceMediaEncoder(['audio'], budget);
          for (const w of decoded) {
            const raw = await encoder.embedAudio(w.data);
            windows.push({
              startMs: w.startMs,
              endMs: w.endMs,
              vector: Array.from(profileUnitVector(MEDIA_SEARCH_PROFILE, raw)),
            });
          }
        }
      } else {
        const decoded = await decodeVideoWindows(ffmpeg.path, job.path, MEDIA_SEARCH_PROFILE);
        if (decoded.length > 0) {
          const encoder = await loadWorkspaceMediaEncoder(['video'], budget);
          for (const w of decoded) {
            const raw = await encoder.embedVideo(w.data, (w.endMs - w.startMs) / 1000);
            windows.push({
              startMs: w.startMs,
              endMs: w.endMs,
              vector: Array.from(profileUnitVector(MEDIA_SEARCH_PROFILE, raw)),
            });
          }
        }
      }
      out.push(
        windows.length > 0
          ? { hash: job.hash, windows }
          : {
              hash: job.hash,
              skip: 'unsupported',
              detail: 'no audio or frames long enough to embed',
            },
      );
    } catch (err) {
      if (err instanceof PipelineLoadError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      out.push(
        /ffmpeg exited|no video stream/.test(message)
          ? { hash: job.hash, skip: 'decode-failed', detail: message }
          : { hash: job.hash, error: message },
      );
    }
  }
  return out;
}
