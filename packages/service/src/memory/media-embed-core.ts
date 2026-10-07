/**
 * Multimodal embedding core: images, video windows and audio windows into the
 * text space of a multimodal knowledge profile (EmbeddingGemma 2), through
 * the encoders that profile pins. Shared by the workspace media lane (in the
 * image-embed worker) and the catalog compiler (via `embedMedia`), so a photo
 * in a project and a photo in a catalog land on the same vector.
 *
 * Pixels come from image-pixels.ts and are resized here, to EXACTLY the size
 * the Gemma 4 image processor would pick for the profile's token budget. The
 * processor then finds nothing to resize and never reaches its sharp-backed
 * path — gezel ships a throwing sharp stub (packages/sharp-compat), so that
 * path would fail by design.
 *
 * Every embed returns the model's raw output; callers project it through the
 * profile (`profileUnitVector`), like text passages.
 */

import type { KnowledgeEmbeddingProfile } from '@bendyline/gezel';
import {
  EmbedderUnavailableError,
  transformersGraphOptions,
  verifyMediaArtifacts,
  verifyProfileArtifacts,
} from '@bendyline/gezel-knowledge';
import { HF_CACHE_DIR_ENV, TRANSFORMERS_MODULE, isMissingModule } from '../transformers-cache.js';
import {
  type RgbImage,
  gemmaVisionTargetSize,
  isGemmaVisionSize,
  resizeBicubic,
} from './image-pixels.js';

export type MediaModality = 'image' | 'video' | 'audio';

export interface MediaEncoder {
  readonly profile: KnowledgeEmbeddingProfile;
  readonly modalities: ReadonlySet<MediaModality>;
  /** One still image. */
  embedImage(image: RgbImage): Promise<number[]>;
  /** One window of video: its frames (already sampled, ≤ maxFrames) and their span. */
  embedVideo(frames: RgbImage[], durationSeconds: number): Promise<number[]>;
  /** One window of mono audio at the profile's sample rate. */
  embedAudio(samples: Float32Array): Promise<number[]>;
  dispose(): Promise<void>;
}

interface TensorLike {
  data: ArrayLike<number>;
  dims: number[];
}

type EncoderModel = ((inputs: unknown) => Promise<Record<string, TensorLike>>) & {
  dispose?: () => Promise<unknown>;
};

interface ImageProcessorLike {
  max_soft_tokens: number;
  do_resize: boolean;
}

type ProcessorLike = ((
  text: string | string[] | null,
  images?: unknown,
  audio?: unknown,
  videos?: unknown,
) => Promise<unknown>) & {
  image_processor?: ImageProcessorLike;
  video_processor?: { frame_processor: ImageProcessorLike; max_frames: number };
};

/** The slice of `@huggingface/transformers` the media path drives; injectable for tests. */
export interface MediaTransformers {
  AutoConfig: {
    from_pretrained(
      model: string,
      options?: Record<string, unknown>,
    ): Promise<Record<string, unknown>>;
  };
  AutoModel: {
    from_pretrained(model: string, options?: Record<string, unknown>): Promise<EncoderModel>;
  };
  AutoProcessor: {
    from_pretrained(model: string, options?: Record<string, unknown>): Promise<ProcessorLike>;
  };
  RawImage: new (
    data: Uint8ClampedArray | Uint8Array,
    width: number,
    height: number,
    channels: number,
  ) => unknown;
  RawVideo: new (frames: unknown[], duration: number) => unknown;
  env: { cacheDir?: string; useFSCache?: boolean; allowRemoteModels?: boolean };
}

/** transformers.js session key → dtype, read off each pinned graph's file name. */
function sessionDtypes(
  profile: KnowledgeEmbeddingProfile,
  modalities: ReadonlySet<MediaModality>,
): { dtype: Record<string, string>; externalData: Record<string, number> } {
  const dtype: Record<string, string> = {};
  const externalData: Record<string, number> = {};
  const add = (
    session: string,
    graph: { onnxFile?: string; files?: Array<{ path: string }> },
    fallback: string,
  ) => {
    const onnxFile = graph.onnxFile ?? fallback;
    const options = transformersGraphOptions(onnxFile);
    if (!options) {
      throw new EmbedderUnavailableError(
        `profile ${profile.id} pins ${onnxFile}, which is not a named ONNX graph`,
      );
    }
    dtype[session] = options.dtype;
    const name = onnxFile.slice(onnxFile.lastIndexOf('/') + 1);
    const prefix = `${onnxFile}_data`;
    const chunks = (graph.files ?? []).filter(
      (f) => f.path === prefix || /^_\d+$/.test(f.path.slice(prefix.length)),
    ).length;
    if (chunks > 0) externalData[name] = chunks;
  };
  add('model', profile.model, 'onnx/model.onnx');
  const media = profile.media;
  if (modalities.has('image') || modalities.has('video')) {
    if (!media?.image)
      throw new EmbedderUnavailableError(`profile ${profile.id} describes no image encoder`);
    add('vision_encoder', media.image.encoder, media.image.encoder.onnxFile);
  }
  if (modalities.has('audio')) {
    if (!media?.audio)
      throw new EmbedderUnavailableError(`profile ${profile.id} describes no audio encoder`);
    add('audio_encoder', media.audio.encoder, media.audio.encoder.onnxFile);
  }
  return { dtype, externalData };
}

function rawImage(lib: MediaTransformers, image: RgbImage): unknown {
  return new lib.RawImage(image.data, image.width, image.height, 3);
}

function sentenceEmbedding(outputs: Record<string, TensorLike>): number[] {
  const pooled = outputs.sentence_embedding;
  if (!pooled) throw new Error('the multimodal encoder returned no sentence_embedding');
  const width = pooled.dims[pooled.dims.length - 1] ?? 0;
  return Array.from({ length: width }, (_, d) => pooled.data[d] as number);
}

async function loadTransformers(): Promise<MediaTransformers> {
  try {
    return (await import(TRANSFORMERS_MODULE)) as unknown as MediaTransformers;
  } catch (err) {
    if (isMissingModule(err, TRANSFORMERS_MODULE)) {
      throw new EmbedderUnavailableError(
        'Local media embeddings need the optional @huggingface/transformers runtime.',
        { runtimeMissing: true },
      );
    }
    throw err;
  }
}

/**
 * Load a profile's text session plus the media encoders `modalities` need,
 * then verify every pinned file the load touched against the profile.
 */
export async function loadMediaEncoder(
  profile: KnowledgeEmbeddingProfile,
  opts: {
    modalities: readonly MediaModality[];
    cacheDir?: string;
    /** Read cached model files only; never initiate a download. */
    localFilesOnly?: boolean;
    sessionOptions?: Record<string, unknown>;
    /**
     * Vision tokens per image instead of the profile's `tokenBudget`: same
     * space, different fidelity. A store keyed on its vectors must key on
     * this too, since a budget change moves every image vector.
     */
    imageTokenBudget?: number;
    /** Test seam: a stand-in for `@huggingface/transformers`. */
    transformers?: MediaTransformers;
  },
): Promise<MediaEncoder> {
  const modalities = new Set<MediaModality>(opts.modalities);
  const media = profile.media;
  const { dtype, externalData } = sessionDtypes(profile, modalities);
  const lib = opts.transformers ?? (await loadTransformers());
  const cacheDir = opts.cacheDir ?? process.env[HF_CACHE_DIR_ENV];
  if (cacheDir) {
    lib.env.cacheDir = cacheDir;
    lib.env.useFSCache = true;
    lib.env.allowRemoteModels = true;
  }
  const repo = profile.model.repo;
  const common = {
    revision: profile.model.revision,
    ...(opts.localFilesOnly ? { local_files_only: true } : {}),
  };
  const config = await lib.AutoConfig.from_pretrained(repo, common);
  const visual = modalities.has('image') || modalities.has('video');
  const [model, processor] = await Promise.all([
    lib.AutoModel.from_pretrained(repo, {
      ...common,
      config: {
        ...config,
        ...(visual ? {} : { vision_config: null }),
        ...(modalities.has('audio') ? {} : { audio_config: null }),
      },
      dtype,
      subfolder: 'onnx',
      ...(Object.keys(externalData).length > 0 ? { use_external_data_format: externalData } : {}),
      ...(opts.sessionOptions ? { session_options: opts.sessionOptions } : {}),
    }),
    lib.AutoProcessor.from_pretrained(repo, common),
  ]);
  try {
    const dir = cacheDir ?? lib.env.cacheDir ?? '';
    await verifyProfileArtifacts(profile, { cacheDir: dir });
    await verifyMediaArtifacts(profile, [...modalities], { cacheDir: dir });
  } catch (err) {
    await model.dispose?.().catch(() => {});
    throw err;
  }

  const imageBudget = opts.imageTokenBudget ?? media?.image?.tokenBudget ?? 0;
  const frameBudget = media?.video?.tokenBudgetPerFrame ?? 0;
  // Sizing happens here, once, from the source dimensions (as the Python
  // processor does). The JS processor would otherwise re-derive a size from
  // our already-sized pixels — its rule is not idempotent — and resize again
  // through sharp, which Gezel does not ship.
  if (processor.image_processor) {
    processor.image_processor.do_resize = false;
    if (imageBudget > 0) processor.image_processor.max_soft_tokens = imageBudget;
  }
  if (processor.video_processor && media?.video) {
    processor.video_processor.frame_processor.do_resize = false;
    processor.video_processor.frame_processor.max_soft_tokens = frameBudget;
    processor.video_processor.max_frames = media.video.maxFrames;
  }
  const run = async (inputs: unknown): Promise<number[]> => sentenceEmbedding(await model(inputs));
  const fit = (image: RgbImage, budget: number): RgbImage => {
    const size = gemmaVisionTargetSize(image.width, image.height, budget);
    return resizeBicubic(image, size.width, size.height);
  };

  return {
    profile,
    modalities,
    embedImage: async (image) => {
      if (!visual) throw new Error('this media encoder was loaded without the image encoder');
      return run(await processor(null, rawImage(lib, fit(image, imageBudget))));
    },
    embedVideo: async (frames, durationSeconds) => {
      if (!media?.video || !visual) {
        throw new Error('this media encoder was loaded without video support');
      }
      if (frames.length === 0) throw new Error('a video window needs at least one frame');
      const sized = frames
        .slice(0, media.video.maxFrames)
        .map((f) => (isGemmaVisionSize(f.width, f.height, frameBudget) ? f : fit(f, frameBudget)));
      const video = new lib.RawVideo(
        sized.map((f) => rawImage(lib, f)),
        durationSeconds,
      );
      return run(await processor(null, null, null, video));
    },
    embedAudio: async (samples) => {
      if (!modalities.has('audio')) {
        throw new Error('this media encoder was loaded without the audio encoder');
      }
      return run(await processor(null, null, samples));
    },
    dispose: async () => {
      await model.dispose?.();
    },
  };
}
