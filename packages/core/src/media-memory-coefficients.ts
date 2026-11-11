/**
 * Working-memory coefficients for the video engines: what an engine holds
 * beyond its weights, as a function of the clip it renders. The weights are
 * exact (priced from their headers); these are the fitted part, and each set
 * says how much to trust it:
 *
 * - `measured`: fit from video-bench runs on this engine, backend and
 *   architecture. `source` names the calibration fixture.
 * - `borrowed`: another architecture's or backend's measured set.
 * - `provisional`: nothing measured yet. The fixed share is anchored to the
 *   price Gezel charged before sizes were priced (20% of the weights plus
 *   12 GiB, measured once for LTX-2.3 on a Mac), so a model's verdict at its
 *   default size is unchanged until a measurement replaces it. Only how the
 *   price moves with size comes from the slopes below.
 *
 * Calibration method and tables: docs/media-model-memory.md. Change these
 * from bench data (`evals/src/bin/fit-media-memory.ts`), never by hand-tuning
 * one verdict. Pure and browser-safe.
 */
import type { VideoArchitecture, VideoEngine } from './schemas/catalog.js';
import type { MediaBackend } from './schemas/video.js';
import { VIDEO_ARCHITECTURES } from './video-geometry.js';

const GIB = 1024 ** 3;
const MPF = 1_000_000;

/**
 * How the VAE decodes the clip: whole, a frame tile at a time, tiles of a
 * few latent frames at a time as well (sd.cpp's `--temporal-tiling`), or with
 * the tiny decoder (TAEHV, sd.cpp's `--tae`) in place of the full VAE.
 */
export type VideoVaeDecode = 'untiled' | 'spatial' | 'temporal' | 'tiny';

export type MediaCalibrationStatus = 'measured' | 'borrowed' | 'provisional';

/**
 * Decode memory: `base + bytesPerFrame x F + bytesPerPixel x W x H +
 * bytesPerPixelFrame x W x H x F`, never below zero. A decoder that tiles
 * each frame to a fixed size follows the frame count alone (`bytesPerFrame`).
 */
export interface VideoDecodeLine {
  baseBytes: number;
  bytesPerFrame?: number;
  bytesPerPixel: number;
  bytesPerPixelFrame: number;
}

export interface VideoMemoryCoefficients {
  status: MediaCalibrationStatus;
  /** The calibration fixture these came from, or why there is none. */
  source: string;
  /**
   * Engine, runtime and driver memory held whatever the clip. `anchor-legacy`
   * derives it per model so the price at the model's default size equals the
   * legacy price (see the module comment).
   */
  fixedBytes: number | 'anchor-legacy';
  /** The fixed share never falls below this, anchored or not. */
  minFixedBytes: number;
  /**
   * The fixed share while decoding, when it differs from sampling's: the
   * sampler's state and the text encoder's buffer are gone by then. Defaults
   * to the sampling share.
   */
  decodeFixedBytes?: number;
  /**
   * Held beyond the weights while the engine loads, before any graph runs
   * (read buffers and the like). The first clip after a launch pays it, so
   * it is a phase of every price. Zero where unmeasured.
   */
  loadBytes?: number;
  /**
   * Held while loading per byte of a GGUF text encoder, beside `loadBytes`:
   * the load's extra memory followed that file's size, not the model's (see
   * {@link SD_CPP_METAL_LOAD_PER_ENCODER_BYTE}).
   */
  loadBytesPerEncoderByte?: number;
  /**
   * Transformer activations while sampling, per token and per unit of the
   * architecture's hidden width, for one batch element. Diffusers batches a
   * guided and an unguided pass together, doubling it; sd-server runs them
   * one after the other, so its buffer is one pass whatever the guidance.
   * Scaling by width lets a set measured on one architecture price a sibling.
   */
  sampleBytesPerTokenWidth: number;
  /**
   * The sampling buffer's part that does not follow the clip's tokens, per
   * batch element. LTX-2's joint graph attends over text and audio tokens as
   * well as the clip's: its buffer was 8.49 GiB at 1,536 video tokens, 9.05
   * at 1,792 and 28.93 at 6,144, a line through 1.68 GiB. Zero elsewhere.
   */
  sampleBaseBytes?: number;
  /**
   * Working memory charged, beside the fixed share, when the render animates
   * a picture, as a phase of its own rather than on top of sampling. Wan2.2
   * TI2V-5B Turbo once peaked at 10.74 GiB from a picture at 1280x704x33,
   * against 9.06 to 9.66 from words (a repeat render held 9.31), yet held
   * 12.82 against 12.69 at its default 1280x704x121. The picture is encoded
   * before the diffusion model and text encoder load, so this covers what
   * was measured, not a known allocation. Unset where unmeasured.
   */
  imageToVideoBytes?: number;
  /** Attention that materializes its score matrix grows with tokens squared; zero with flash attention. */
  sampleBytesPerTokenSquared: number;
  /**
   * Host memory that follows the clip's pixels through sampling: sd.cpp
   * holds the clip as float32 frames from the start.
   */
  sampleBytesPerPixelFrame?: number;
  /** Per decode mode. A causal VAE (Wan) and a whole-clip VAE (LTX) need different lines. */
  decode: Readonly<Record<VideoVaeDecode, VideoDecodeLine>>;
  /**
   * Decode this way off CUDA instead of taking the smaller line, while the
   * lines are guesses: an engine's behavior should not change on a guess.
   */
  preferredDecode?: VideoVaeDecode;
  /** Added over the fitted working memory: a share of it, then at least this many bytes. */
  margin: { relative: number; absoluteBytes: number };
}

/**
 * Decoded frames held at float32 RGB plus their 8-bit copy for the encoder:
 * 15 bytes a pixel-frame, whatever the VAE.
 */
const FRAME_BUFFER_BYTES = 15;

/**
 * The tiny decoder holds a few megabytes of weights and works frame by frame:
 * Wan2.2 TI2V-5B at 640x352x33 peaked 1.8 GB over its weights with it on an
 * M5 Max (2026-11-09), sampling included.
 */
const TINY_DECODE: VideoDecodeLine = {
  baseBytes: 0.5 * GIB,
  bytesPerPixel: 0,
  bytesPerPixelFrame: FRAME_BUFFER_BYTES,
};

/**
 * LTX-2's VAE decoding at float32 on Metal, measured 2026-09-28 (driver peak,
 * 121 frames): 14.5 GiB untiled at 768x512 and 39.1 GiB at 1280x704; tiled,
 * 18.8 and 24.4 GiB. A whole-clip decode follows pixels times frames.
 */
const WHOLE_CLIP_DECODE: Readonly<Record<VideoVaeDecode, VideoDecodeLine>> = {
  untiled: { baseBytes: -4.6 * GIB, bytesPerPixel: 0, bytesPerPixelFrame: (0.4 * GIB) / MPF },
  spatial: { baseBytes: 14.5 * GIB, bytesPerPixel: 0, bytesPerPixelFrame: (0.091 * GIB) / MPF },
  temporal: { baseBytes: 1 * GIB, bytesPerPixel: 0, bytesPerPixelFrame: FRAME_BUFFER_BYTES },
  tiny: TINY_DECODE,
};

/**
 * Wan's causal VAE decodes one latent frame (four video frames) at a time
 * with a cache carried forward, so it follows the frame size. Unmeasured:
 * four whole-clip frames at the LTX rate, doubled for the cache.
 */
const CAUSAL_DECODE: Readonly<Record<VideoVaeDecode, VideoDecodeLine>> = {
  untiled: {
    baseBytes: 0,
    bytesPerPixel: 8 * ((0.4 * GIB) / MPF),
    bytesPerPixelFrame: FRAME_BUFFER_BYTES,
  },
  spatial: {
    baseBytes: 2 * GIB,
    bytesPerPixel: (0.4 * GIB) / MPF,
    bytesPerPixelFrame: FRAME_BUFFER_BYTES,
  },
  temporal: { baseBytes: 1 * GIB, bytesPerPixel: 0, bytesPerPixelFrame: FRAME_BUFFER_BYTES },
  tiny: TINY_DECODE,
};

/** Hidden, attention and feed-forward activations of one block at bfloat16, roughly 24 values a width unit. */
const PROVISIONAL_SAMPLE_BYTES_PER_TOKEN_WIDTH = 48;

function provisional(engine: VideoEngine, causal: boolean): VideoMemoryCoefficients {
  return {
    status: 'provisional',
    source: `no ${engine} video measurement yet; anchored to the legacy price at the default size`,
    fixedBytes: 'anchor-legacy',
    minFixedBytes: engine === 'sd-cpp' ? 1.5 * GIB : 4 * GIB,
    sampleBytesPerTokenWidth: PROVISIONAL_SAMPLE_BYTES_PER_TOKEN_WIDTH,
    sampleBytesPerTokenSquared: 0,
    decode: causal ? CAUSAL_DECODE : WHOLE_CLIP_DECODE,
    // The causal lines are unmeasured; the diffusers server decodes Wan whole off CUDA today.
    ...(causal ? { preferredDecode: 'untiled' as const } : {}),
    margin: { relative: 0, absoluteBytes: 0 },
  };
}

/**
 * sd.cpp's tiny decoder (TAEHV) tiles each frame to a fixed size, so its
 * buffer follows the frame count, and how much per frame depends on the
 * architecture's decoder. Wan2.2's: 0.53 GiB at 17 frames, 0.95 GiB at 33 and
 * 3.27 GiB at 121, at every size measured (M5 Max, 2026-11-09). The decoded
 * frames are held beside it.
 */
const SD_CPP_WAN22_TINY_DECODE: VideoDecodeLine = {
  baseBytes: 0.1 * GIB,
  bytesPerFrame: 28.1e6,
  bytesPerPixel: 0,
  bytesPerPixelFrame: FRAME_BUFFER_BYTES,
};

/** Wan2.1's tiny decoder holds four times Wan2.2's per frame: 3.80 GiB at 33 frames, 8.86 at 81. */
const SD_CPP_WAN21_TINY_DECODE: VideoDecodeLine = {
  baseBytes: 0.32 * GIB,
  bytesPerFrame: 113.2e6,
  bytesPerPixel: 0,
  bytesPerPixelFrame: FRAME_BUFFER_BYTES,
};

/**
 * sd.cpp's full Wan2.1 VAE with spatial tiling and no temporal tiling
 * decodes fixed-size tiles frame after frame, so its buffer holds still: 2.13
 * GiB at 480x480x17 and 2.15 at 33 (LingBot, M5 Max, 2026-11-10). The
 * decoded frames are held beside it.
 */
const SD_CPP_WAN21_VAE_SPATIAL_DECODE: VideoDecodeLine = {
  baseBytes: 2.2 * GIB,
  bytesPerPixel: 0,
  bytesPerPixelFrame: FRAME_BUFFER_BYTES,
};

/**
 * What sd-server holds on Metal beyond its weights, its sampling buffer and
 * the clip's float32 frames while sampling, the text encoder's compute buffer
 * (0.35 GiB) among it: 1.04 and 0.96 GiB for Wan2.2 Q4 and Q8 at their
 * default 1280x704x121, up to 1.45 at 1280x704x33 (GPU-held memory counted,
 * 2026-11-10). Short-lived allocations during sampling account for the
 * spread: a 0.25 s trace of Wan2.2 Q4 showed GPU memory 1.8 GiB beyond its
 * weights and buffer for a moment, and repeat renders of one clip differ by
 * 0.5 GiB. The frames are `SD_CPP_SAMPLE_BYTES_PER_PIXEL_FRAME`.
 */
const SD_CPP_METAL_FIXED_BYTES = 1.4 * GIB;
const SD_CPP_SAMPLE_BYTES_PER_PIXEL_FRAME = FRAME_BUFFER_BYTES;

/** The same while decoding: 0.35 GiB beyond the tiny decoder's buffer (Wan2.2 Q4, 640x512x33). */
const SD_CPP_METAL_DECODE_FIXED_BYTES = 0.4 * GIB;

/**
 * The same around the full Wan VAE's tiles: 0.6 GiB beyond the weights and
 * its buffer (LingBot at 480x480x17, where decoding was the peak).
 */
const SD_CPP_METAL_VAE_DECODE_FIXED_BYTES = 0.6 * GIB;

/**
 * Held beyond the weights while sd-server loads, before any graph runs: a
 * base plus 0.41 of a GGUF text encoder's bytes. Wan2.2 Q4 held 1.84 GiB with
 * its 3.4 GiB UMT5, Wan2.2 Q8 2.73 and Wan2.1 2.77 with the 5.6 GiB one,
 * whatever their diffusion models weighed (M5 Max, 2026-11-10, where loading
 * was the peak). LingBot with an 8.3 GiB bf16 safetensors Qwen3-VL held no
 * more than 2.1 GiB beyond its weights at any point, so a safetensors
 * encoder adds nothing here.
 */
const SD_CPP_METAL_LOAD_BASE_BYTES = 0.47 * GIB;
const SD_CPP_METAL_LOAD_PER_ENCODER_BYTE = 0.41;

/** Wan2.1's fixed share while sampling, measured at its default clip. */
const SD_CPP_METAL_WAN21_FIXED_BYTES = 1.4 * GIB;

/**
 * LTX-2 on sd.cpp, which decodes the whole clip in spatial and temporal
 * tiles, so the decoder's own buffer holds still (0.37 GiB at 512x512x49 and
 * 768x512x121). The decode phase's host share sits in `decodeFixedBytes`.
 */
const SD_CPP_LTX_TILED_DECODE: VideoDecodeLine = {
  baseBytes: 0.4 * GIB,
  bytesPerPixel: 0,
  bytesPerPixelFrame: FRAME_BUFFER_BYTES,
};

/**
 * Bytes sd-server holds beyond a diffusion model file's size: layers its
 * model definition creates at float32 whatever the file stores. LTX-2's
 * timestep modulation (`AdaLayerNormSingle`, a `force_f32` Linear) is 427M
 * elements, stored bf16 in the catalog's GGUFs, so it loads at twice its
 * size: 815 MiB over the file for LTX-2.3 22B, exactly what sd-server
 * reported (master-1050, 2026-11-09).
 */
const SD_CPP_WIDENED_BYTES: Partial<Record<VideoArchitecture, number>> = {
  'ltx-2': 427_294_720 * 2,
};

export function sdCppWidenedBytes(architecture: VideoArchitecture): number {
  return SD_CPP_WIDENED_BYTES[architecture] ?? 0;
}

/** Sampling and decode buffers are what sd-server reports; the margin covers the rest. */
const SD_CPP_MEASURED_MARGIN = { relative: 0.1, absoluteBytes: 0.5 * GIB };

/**
 * Sets fit from bench runs, keyed `engine:backend:architecture`
 * (docs/media-model-memory.md, "Calibration"), checked against every clip in
 * __fixtures__/media-memory/ by media-memory.calibration.test.ts. The
 * sampling slope is the diffusion model's compute buffer as sd-server
 * reported it, linear in latent tokens with flash attention on; it is not one
 * constant per width across architectures (Wan2.1's narrower model spends
 * more per unit). The fixed shares and the load phase are what the peak held
 * beyond those buffers, with GPU-held memory counted.
 */
const MEASURED: Readonly<Record<string, VideoMemoryCoefficients>> = {
  'sd-cpp:metal:wan2.2-ti2v-5b': {
    status: 'measured',
    source:
      'video bench 2026-11-10, M5 Max (sd-cpp-metal-m5max.json): Wan2.2 TI2V-5B Q4_K_M and Q8_0, 512x512x17 to 1280x704x121',
    fixedBytes: SD_CPP_METAL_FIXED_BYTES,
    minFixedBytes: SD_CPP_METAL_FIXED_BYTES,
    decodeFixedBytes: SD_CPP_METAL_DECODE_FIXED_BYTES,
    loadBytes: SD_CPP_METAL_LOAD_BASE_BYTES,
    loadBytesPerEncoderByte: SD_CPP_METAL_LOAD_PER_ENCODER_BYTE,
    // 50.0 fitted over five guided clips, worst residual 0.01 GiB; Wan2.2
    // TI2V-5B Turbo (guidance 1) held the same 1.18 GiB at 1280x704x33.
    sampleBytesPerTokenWidth: 52,
    sampleBytesPerTokenSquared: 0,
    sampleBytesPerPixelFrame: SD_CPP_SAMPLE_BYTES_PER_PIXEL_FRAME,
    imageToVideoBytes: 2.4 * GIB,
    decode: { ...CAUSAL_DECODE, tiny: SD_CPP_WAN22_TINY_DECODE },
    margin: SD_CPP_MEASURED_MARGIN,
  },
  'sd-cpp:metal:wan2.1-1.3b': {
    status: 'measured',
    source:
      'video bench 2026-11-10, M5 Max (sd-cpp-metal-m5max.json): Wan2.1 T2V 1.3B fp16 at 480x480x33, 832x480x33, 480x480x81 (256- and 128-pixel decoder tiles) and its default 832x480x81',
    // The default clip (832x480x81) held 1.82 GiB beyond its weights and
    // sampling buffer, 1.68 of it host memory, against Wan2.2's 0.75 plus
    // frames; the 480x480x81 clip held as much host memory while loading.
    fixedBytes: SD_CPP_METAL_WAN21_FIXED_BYTES,
    minFixedBytes: SD_CPP_METAL_WAN21_FIXED_BYTES,
    decodeFixedBytes: SD_CPP_METAL_DECODE_FIXED_BYTES,
    loadBytes: SD_CPP_METAL_LOAD_BASE_BYTES,
    loadBytesPerEncoderByte: SD_CPP_METAL_LOAD_PER_ENCODER_BYTE,
    // 72.4 fitted at 33 frames; 71.6 at 832x480x81.
    sampleBytesPerTokenWidth: 74,
    sampleBytesPerTokenSquared: 0,
    sampleBytesPerPixelFrame: SD_CPP_SAMPLE_BYTES_PER_PIXEL_FRAME,
    decode: { ...CAUSAL_DECODE, tiny: SD_CPP_WAN21_TINY_DECODE },
    margin: SD_CPP_MEASURED_MARGIN,
  },
  'sd-cpp:metal:lingbot-video-1.3b': {
    status: 'measured',
    source:
      'video bench 2026-11-10, M5 Max (sd-cpp-metal-m5max.json): LingBot-Video dense 1.3B at 480x480x17, 480x480x33, 832x480x17 and its default 832x480x81, full Wan2.1 VAE',
    fixedBytes: SD_CPP_METAL_FIXED_BYTES,
    minFixedBytes: SD_CPP_METAL_FIXED_BYTES,
    decodeFixedBytes: SD_CPP_METAL_VAE_DECODE_FIXED_BYTES,
    loadBytes: SD_CPP_METAL_LOAD_BASE_BYTES,
    loadBytesPerEncoderByte: SD_CPP_METAL_LOAD_PER_ENCODER_BYTE,
    // 160.8 at 17 frames, 156.6 at 33, 150.4 at 832x480x81: sd.cpp repeats
    // the timestep embedding for every token, about twice Wan2.1's cost.
    sampleBytesPerTokenWidth: 162,
    sampleBytesPerTokenSquared: 0,
    sampleBytesPerPixelFrame: SD_CPP_SAMPLE_BYTES_PER_PIXEL_FRAME,
    decode: { ...CAUSAL_DECODE, spatial: SD_CPP_WAN21_VAE_SPATIAL_DECODE },
    margin: SD_CPP_MEASURED_MARGIN,
  },
  'sd-cpp:metal:ltx-2': {
    status: 'measured',
    source:
      'video bench 2026-11-10, M5 Max (sd-cpp-metal-m5max.json): LTX-2.3 22B distilled Q4_K_M at 512x512x49, 768x512x121, and 768x512x25 from a picture',
    // Beyond the weights and the sampling buffer: 3.81 GiB animating a
    // picture at 768x512x25, 2.4 at 512x512x49 and 0.95 at 768x512x121; host
    // memory, less the VAE, which loads only to decode.
    fixedBytes: 3.85 * GIB,
    minFixedBytes: 3.85 * GIB,
    // The decode phase held 4.5 to 6 GiB beyond the weights, host-side.
    decodeFixedBytes: 5.5 * GIB,
    // The engine's buffer: 1163 bytes a token-width over a
    // 1.68 GiB base. sd.cpp holds LTX-2's timestep modulation per token, so
    // it costs 22 times Wan2.2 per token-width.
    sampleBytesPerTokenWidth: 1163,
    sampleBaseBytes: 1.68 * GIB,
    sampleBytesPerTokenSquared: 0,
    decode: { ...WHOLE_CLIP_DECODE, temporal: SD_CPP_LTX_TILED_DECODE },
    margin: SD_CPP_MEASURED_MARGIN,
  },
};

export function videoCoefficientKey(
  engine: VideoEngine,
  backend: MediaBackend,
  architecture: VideoArchitecture,
): string {
  return `${engine}:${backend}:${architecture}`;
}

/**
 * The coefficients to price one engine, backend and architecture with: a
 * measured set when there is one, else the measured sibling on the same
 * engine and backend that charges the most per token-width (marked
 * `borrowed`; the per-width cost differs between architectures, so the
 * larger one is the safe guess), else provisional.
 */
export function videoMemoryCoefficients(
  engine: VideoEngine,
  backend: MediaBackend,
  architecture: VideoArchitecture,
): VideoMemoryCoefficients {
  const exact = MEASURED[videoCoefficientKey(engine, backend, architecture)];
  if (exact) return exact;
  const causal = VIDEO_ARCHITECTURES[architecture].causalDecode;
  const sibling = Object.entries(MEASURED)
    .filter(([key]) => {
      const [e, b, arch] = key.split(':') as [VideoEngine, MediaBackend, VideoArchitecture];
      return e === engine && b === backend && VIDEO_ARCHITECTURES[arch].causalDecode === causal;
    })
    .sort(([, a], [, b]) => b.sampleBytesPerTokenWidth - a.sampleBytesPerTokenWidth)[0];
  if (sibling) {
    return { ...sibling[1], status: 'borrowed', source: `borrowed from ${sibling[0]}` };
  }
  return provisional(engine, causal);
}

/**
 * Every set worth pricing an engine, backend and architecture with; the
 * caller charges the costliest. Unmeasured, that is the guess above plus the
 * same architecture as measured on another backend: the graph's buffers
 * follow the architecture far more than the backend (LTX-2 spends 50 times
 * Wan's bytes per token-width), and the provisional set priced LTX-2.3 at
 * 41 GiB where Metal measured 54.
 */
export function videoMemoryCoefficientCandidates(
  engine: VideoEngine,
  backend: MediaBackend,
  architecture: VideoArchitecture,
): VideoMemoryCoefficients[] {
  const first = videoMemoryCoefficients(engine, backend, architecture);
  if (first.status === 'measured') return [first];
  const elsewhere = Object.entries(MEASURED)
    .filter(([key]) => {
      const [e, , arch] = key.split(':');
      return e === engine && arch === architecture;
    })
    .map(([key, set]) => ({ ...set, status: 'borrowed' as const, source: `borrowed from ${key}` }));
  return [first, ...elsewhere];
}
