/**
 * How much memory a local image or video model needs, and whether this
 * machine can run it.
 *
 * One pricing for every caller. The download pages price a catalog entry
 * before a byte is downloaded, from the `tensors` facts gilde pins beside
 * each file's sha256; the launch path prices the files on disk, reading the
 * same facts from their headers. Both hand them to the functions here, so a
 * model the download page hides is exactly a model the launch path would
 * refuse. Nothing here, or on the way here, touches the network.
 *
 * The catalog's hand-authored `minRamGB` / `minVramGB` are not read. They
 * disagreed with what the engines load by up to 15 GB in both directions: a
 * text encoder published as float32 loads at half its size, an FP8 one at
 * twice, and the 19-22B LTX-2 models stream components through a CUDA card
 * rather than holding them all.
 *
 * Pure and browser-safe. Contract and calibration: docs/media-model-memory.md.
 */
import {
  type MediaCalibrationStatus,
  type VideoDecodeLine,
  type VideoMemoryCoefficients,
  type VideoVaeDecode,
  sdCppWidenedBytes,
  videoMemoryCoefficientCandidates,
  videoMemoryCoefficients,
} from './media-memory-coefficients.js';
import type {
  SdCppVideoRender,
  VideoArchitecture,
  VideoEngine,
  VideoModelFamily,
  WeightTensors,
} from './schemas/catalog.js';
import type { MediaFitAssessment, MediaFitVerdict, MediaMemoryPool } from './schemas/media-fit.js';
import type { MediaBackend, VideoAccelerator } from './schemas/video.js';
import {
  VIDEO_ARCHITECTURES,
  type VideoArchitectureGeometry,
  type VideoRenderSize,
  resolveVideoArchitecture,
  snapVideoFrames,
  videoFrameStep,
  videoLatentTokens,
} from './video-geometry.js';

const GIB = 1024 ** 3;

const STORED_BYTES: Record<string, number> = {
  F64: 8,
  F32: 4,
  F16: 2,
  BF16: 2,
  F8_E4M3: 1,
  F8_E5M2: 1,
  I64: 8,
  I32: 4,
  I16: 2,
  I8: 1,
  U8: 1,
  BOOL: 1,
};
const FLOAT_DTYPES = new Set(['F64', 'F32', 'F16', 'BF16', 'F8_E4M3', 'F8_E5M2']);

/**
 * Tally a parsed safetensors header (the JSON after the 8-byte length
 * prefix) into the catalog's `tensors` shape. gilde's
 * `tools/lib/safetensors.mjs` is the authoring-side twin; the two share a
 * fixture in their tests and must agree.
 */
export function tallySafetensorsHeader(header: unknown): WeightTensors {
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    throw new Error('safetensors header is not a JSON object');
  }
  const floatElements: Record<string, number> = {};
  let otherBytes = 0;
  for (const [name, raw] of Object.entries(header as Record<string, unknown>)) {
    if (name === '__metadata__' || !raw || typeof raw !== 'object') continue;
    const tensor = raw as { dtype?: unknown; shape?: unknown; data_offsets?: unknown };
    if (typeof tensor.dtype !== 'string') continue;
    const shape = Array.isArray(tensor.shape) ? tensor.shape : [];
    const elements = shape.reduce<number>(
      (acc, dim) => acc * (typeof dim === 'number' && dim >= 0 ? dim : 0),
      1,
    );
    if (FLOAT_DTYPES.has(tensor.dtype)) {
      floatElements[tensor.dtype] = (floatElements[tensor.dtype] ?? 0) + elements;
      continue;
    }
    const offsets = tensor.data_offsets;
    const [start, end] = Array.isArray(offsets) ? offsets : [];
    otherBytes +=
      typeof start === 'number' && typeof end === 'number' && end > start
        ? end - start
        : elements * (STORED_BYTES[tensor.dtype] ?? 4);
  }
  return { floatElements, otherBytes };
}

export type WeightFileFormat = 'safetensors' | 'gguf' | 'opaque';

/** A file an engine loads as weights, by extension; null for configs, tokenizers and indexes. */
export function weightFileFormat(name: string): WeightFileFormat | null {
  if (/\.safetensors$/i.test(name)) return 'safetensors';
  if (/\.gguf$/i.test(name)) return 'gguf';
  if (/\.(bin|pt|pth|ckpt)$/i.test(name)) return 'opaque';
  return null;
}

export interface MediaWeightFile {
  /**
   * Pipeline component: a diffusers subfolder (`transformer`, `vae`,
   * `text_encoder`) or a stable-diffusion.cpp role (`model`,
   * `diffusion_model`, `vae`, `t5xxl`, `llm`).
   */
  component: string;
  sizeBytes: number;
  format: WeightFileFormat;
  /** From the catalog entry, or read from the header on disk. Absent: priced by its plausible range. */
  tensors?: WeightTensors;
}

/** Bytes per element an engine holds a stored float dtype at, for one component. */
export type FloatLoadBytes = (dtype: string, component: string) => number;

interface Priced {
  bytes: number;
  floorBytes: number;
  exact: boolean;
}

/**
 * Stored float precisions a safetensors file without `tensors` facts (a
 * catalog entry authored before gilde pinned them) could plausibly hold.
 * F64 is left out: published diffusion weights do not ship it, and admitting
 * it would halve every unread file's floor.
 */
const PLAUSIBLE_STORED_FLOATS = ['F32', 'BF16', 'F8_E4M3'] as const;

function priceFile(file: MediaWeightFile, loadBytes: FloatLoadBytes): Priced {
  if (file.format !== 'safetensors') {
    return { bytes: file.sizeBytes, floorBytes: file.sizeBytes, exact: true };
  }
  if (file.tensors) {
    let bytes = file.tensors.otherBytes;
    for (const [dtype, elements] of Object.entries(file.tensors.floatElements)) {
      bytes += elements * loadBytes(dtype, file.component);
    }
    return { bytes, floorBytes: bytes, exact: true };
  }
  // The size alone cannot say whether a 10 GB text encoder is float32 that
  // loads as 5 GB or bfloat16 that loads as 10. Price the common case, and
  // keep the smallest plausible load as the floor nothing may be hidden below.
  const loads = PLAUSIBLE_STORED_FLOATS.map(
    (dtype) =>
      (file.sizeBytes / (STORED_BYTES[dtype] as number)) * loadBytes(dtype, file.component),
  );
  return { bytes: loads[1] as number, floorBytes: Math.min(...loads), exact: false };
}

interface WeightSummary {
  total: Priced;
  /** The heaviest single component — what a streaming pipeline holds on the card at once. */
  largest: Priced;
  byComponent: ReadonlyMap<string, Priced>;
}

function summarizeWeights(
  files: readonly MediaWeightFile[],
  loadBytes: FloatLoadBytes,
): WeightSummary {
  const byComponent = new Map<string, Priced>();
  for (const file of files) {
    const priced = priceFile(file, loadBytes);
    const prior = byComponent.get(file.component);
    byComponent.set(
      file.component,
      prior
        ? {
            bytes: prior.bytes + priced.bytes,
            floorBytes: prior.floorBytes + priced.floorBytes,
            exact: prior.exact && priced.exact,
          }
        : priced,
    );
  }
  return summaryOf(byComponent);
}

function summaryOf(byComponent: ReadonlyMap<string, Priced>): WeightSummary {
  const components = [...byComponent.values()];
  return {
    total: {
      bytes: components.reduce((sum, c) => sum + c.bytes, 0),
      floorBytes: components.reduce((sum, c) => sum + c.floorBytes, 0),
      exact: components.every((c) => c.exact),
    },
    largest: {
      bytes: Math.max(0, ...components.map((c) => c.bytes)),
      floorBytes: Math.max(0, ...components.map((c) => c.floorBytes)),
      exact: components.every((c) => c.exact),
    },
    byComponent,
  };
}

export interface MediaMemoryFigures {
  /** Weights at the precision the engine loads them in. */
  weightBytes: number;
  /** Peak working set across every pool: weights plus working memory. The device ledger reserves this. */
  bytes: number;
  /**
   * What must sit in graphics memory at once. On a discrete card this is
   * weights only — the one figure here that is a hard floor rather than an
   * estimate, which is why the ledger may refuse on it. Unified: all of
   * `bytes`. Processor: 0.
   */
  gpuBytes: number;
}

/** When an engine needs a component or a working buffer. */
export type MediaPhase = 'load' | 'encode' | 'sample' | 'decode' | 'audio';

export interface MediaMemoryBreakdown {
  /** Weights per component at load precision, with the phase that uses them. */
  components: Array<{ component: string; bytes: number; phase: MediaPhase }>;
  /** Engine, runtime and driver memory held whatever the size. */
  fixedBytes: number;
  /** Working memory each phase needs on top of the weights and the fixed share. */
  phases: Array<{ phase: MediaPhase; workingBytes: number }>;
  /** The phase that sets the peak. */
  peakPhase: MediaPhase;
  /** How the VAE decodes at this size. */
  vaeDecode?: VideoVaeDecode;
}

export interface MediaMemoryRequirement extends MediaMemoryFigures {
  pool: MediaMemoryPool;
  /**
   * Estimated graphics-memory peak on a discrete card: `gpuBytes` plus
   * generation's working memory there. Only ever a warning — it has not been
   * measured on discrete cards.
   */
  gpuPeakBytes: number;
  /** Every weight file's stored precision is known, from the catalog or from disk. */
  exact: boolean;
  /** The same figures with every unread file priced at its smallest plausible load. Equals the rest when `exact`. */
  floor: MediaMemoryFigures;
  /** Set when the price was made for a render size. */
  engine?: VideoEngine;
  backend?: MediaBackend;
  /** How far to trust the working-memory share; see media-memory-coefficients.ts. */
  calibration?: MediaCalibrationStatus;
  size?: VideoRenderSize;
  breakdown?: MediaMemoryBreakdown;
}

function requirementFrom(
  weights: WeightSummary,
  pool: MediaMemoryPool,
  working: (weightBytes: number) => number,
  streamsComponents: boolean,
): MediaMemoryRequirement {
  const figures = (total: number, largest: number): MediaMemoryFigures => {
    const bytes = Math.ceil(total + working(total));
    const onCard = Math.ceil(streamsComponents ? largest : total);
    return {
      weightBytes: Math.ceil(total),
      bytes,
      gpuBytes: pool === 'cpu' ? 0 : pool === 'unified' ? bytes : onCard,
    };
  };
  const expected = figures(weights.total.bytes, weights.largest.bytes);
  const onCard = streamsComponents ? weights.largest.bytes : weights.total.bytes;
  return {
    pool,
    ...expected,
    gpuPeakBytes:
      pool === 'discrete'
        ? Math.ceil(onCard + working(onCard))
        : pool === 'unified'
          ? expected.bytes
          : 0,
    exact: weights.total.exact,
    floor: figures(weights.total.floorBytes, weights.largest.floorBytes),
  };
}

// ─ Video (diffusers, gezel_video_server.py) ─────────────────────────

/**
 * Working memory over the weights. Measured for LTX-2.3 distilled on an
 * M-series Mac at the catalog default (768x512, 121 frames): 67 GiB of
 * weights settled at a 74 GiB footprint through sampling, then the float32
 * VAE decode of the whole clip peaked at 89 GiB. This covers that peak with a
 * few GiB to spare; a larger frame size decodes proportionally more.
 */
export const VIDEO_WORKING_FRACTION = 0.2;
export const VIDEO_WORKING_FIXED_BYTES = 12 * GIB;

export function videoWorkingBytes(weightBytes: number): number {
  return weightBytes * VIDEO_WORKING_FRACTION + VIDEO_WORKING_FIXED_BYTES;
}

/**
 * Mirrors the server: the processor runs float32 throughout; every
 * accelerator loads bfloat16, except a VAE forced to float32 (WAN always,
 * LTX-2 by catalog). FP8 checkpoints are cast up like everything else.
 */
export function videoFloatLoadBytes(input: {
  family: string;
  accelerator: VideoAccelerator;
  vaeDtype?: 'float32' | 'bfloat16' | undefined;
}): FloatLoadBytes {
  const vaeFloat32 = input.family === 'wan' || input.vaeDtype === 'float32';
  return (_dtype, component) => {
    if (input.accelerator === 'cpu') return 4;
    if (component === 'vae' && vaeFloat32) return 4;
    return 2;
  };
}

/**
 * Mirrors the server: on CUDA the LTX-2 family streams each component onto
 * the card in turn (`enable_model_cpu_offload`), so the card holds the
 * heaviest component, not the pipeline. Everything else moves whole.
 */
export function videoStreamsComponents(family: string, accelerator: VideoAccelerator): boolean {
  return family === 'ltx2' && accelerator === 'cuda';
}

export interface VideoMemoryInput {
  files: readonly MediaWeightFile[];
  family: string;
  /** The diffusers server's device. sd.cpp entries pass the device their pool implies. */
  accelerator: VideoAccelerator;
  pool: MediaMemoryPool;
  vaeDtype?: 'float32' | 'bfloat16' | undefined;
  /** Default `diffusers`. */
  engine?: VideoEngine | undefined;
  architecture?: VideoArchitecture | undefined;
  /** The engine's compute backend; default the diffusers accelerator. */
  backend?: MediaBackend | undefined;
  /**
   * The clip to price. Absent on a diffusers model: the legacy price, which
   * knows nothing of size. Absent on an sd.cpp model: `defaultSize`.
   */
  size?: VideoRenderSize | undefined;
  /** The model's catalog default; anchors provisional coefficients. Default `size`. */
  defaultSize?: VideoRenderSize | undefined;
  /**
   * Above 1 diffusers batches a guided and an unguided pass, doubling the
   * transformer's batch; sd-server runs them in turn and holds one.
   */
  guidanceScale?: number | undefined;
  /** How the VAE decodes; default what the engine does at this size. */
  vaeDecode?: VideoVaeDecode | undefined;
  /**
   * sd.cpp's spatial decode tile, when the entry sets one. A tiled decoder's
   * buffer follows the tile's area, and every sd.cpp decode line was
   * measured at sd.cpp's own default ({@link SD_CPP_DEFAULT_TILE_PX}).
   */
  vaeTileSizePx?: number | undefined;
  /** The render animates a picture, which holds more through sampling. */
  animatesPicture?: boolean | undefined;
  /**
   * sd.cpp on a discrete card: `--max-vram`, the graphics memory it may fill.
   * Weights beyond it stay in system memory, so only this much must fit the card.
   */
  gpuLimitBytes?: number | undefined;
}

const FAMILY_KNOWN: Readonly<Record<VideoModelFamily, true>> = {
  ltx: true,
  ltx2: true,
  wan: true,
  lingbot: true,
};

/**
 * Which pipeline a component's weights serve. Text and conditioning
 * encoders run once before sampling; the VAE after it; anything not
 * recognized counts as sampling, the phase that holds the most.
 */
export function componentPhase(component: string): MediaPhase {
  const name = component.toLowerCase();
  if (name === 'vae' || name === 'tae') return 'decode';
  if (name === 'audio_vae' || name === 'vocoder' || name === 'audio_encoder') return 'audio';
  if (
    name.startsWith('text_encoder') ||
    name.startsWith('clip') ||
    name === 't5xxl' ||
    name === 'llm' ||
    name === 'llm_vision' ||
    name === 'connectors' ||
    name === 'embeddings_connectors' ||
    name === 'image_encoder'
  ) {
    return 'encode';
  }
  return 'sample';
}

/**
 * How the VAE should decode a clip. The diffusers server tiles every CUDA
 * decode; elsewhere it decodes whichever way its price says is smaller, and
 * the daemon sends that choice with the request (`vaeTiling`), so the engine
 * does what it was admitted for. Choosing the smaller line also keeps the
 * price rising with size, where a fixed threshold would let a larger clip
 * price below a smaller one. sd.cpp decodes as its catalog entry says.
 */
export function chooseVideoVaeDecode(input: {
  engine?: VideoEngine | undefined;
  family: string;
  accelerator: VideoAccelerator;
  backend?: MediaBackend | undefined;
  architecture?: VideoArchitecture | undefined;
  size: VideoRenderSize;
  configured?: VideoVaeDecode | undefined;
}): VideoVaeDecode {
  if (input.configured) return input.configured;
  const engine = input.engine ?? 'diffusers';
  if (engine === 'sd-cpp') return 'spatial';
  if (input.accelerator === 'cuda') return 'spatial';
  const architecture =
    input.architecture ??
    (input.family in FAMILY_KNOWN
      ? resolveVideoArchitecture({ family: input.family as VideoModelFamily })
      : undefined);
  if (!architecture) return 'untiled';
  const coefficients = videoMemoryCoefficients(
    engine,
    input.backend ?? input.accelerator,
    architecture,
  );
  if (coefficients.preferredDecode) return coefficients.preferredDecode;
  return decodeBytes(coefficients.decode.spatial, input.size) <
    decodeBytes(coefficients.decode.untiled, input.size)
    ? 'spatial'
    : 'untiled';
}

/**
 * sd.cpp's spatial decode tile when an entry names none: 256 pixels a side.
 * Every sd.cpp decode line was measured at it.
 */
export const SD_CPP_DEFAULT_TILE_PX = 256;

/**
 * A decode line's bytes for one clip. `tileScale` resizes the tile's own
 * buffer (`baseBytes`, `bytesPerFrame`) for a tile of another area; the
 * frames the decoder writes out (`bytesPerPixel`, `bytesPerPixelFrame`) are
 * whole frames whatever the tile. Wan2.1's tiny decoder at 128-pixel tiles
 * held 2.22 GiB at 480x480x81 against 8.86 at 256 (M5 Max, 2026-11-10): a
 * quarter, as the area says.
 */
function decodeBytes(line: VideoDecodeLine, size: VideoRenderSize, tileScale = 1): number {
  const pixels = size.width * size.height;
  return Math.max(
    0,
    tileScale * (line.baseBytes + (line.bytesPerFrame ?? 0) * size.numFrames) +
      line.bytesPerPixel * pixels +
      line.bytesPerPixelFrame * pixels * size.numFrames,
  );
}

interface PhaseWorking {
  phases: Array<{ phase: MediaPhase; workingBytes: number }>;
  peak: { phase: MediaPhase; workingBytes: number };
}

function phaseWorking(
  coefficients: VideoMemoryCoefficients,
  geo: VideoArchitectureGeometry,
  size: VideoRenderSize,
  opts: {
    batch: number;
    activationScale: number;
    vaeDecode: VideoVaeDecode;
    decodeTileScale?: number;
    animatesPicture?: boolean;
  },
): PhaseWorking {
  const tokens = videoLatentTokens(geo, size);
  const sample =
    opts.batch *
      opts.activationScale *
      ((coefficients.sampleBaseBytes ?? 0) +
        coefficients.sampleBytesPerTokenWidth * geo.hiddenSize * tokens +
        coefficients.sampleBytesPerTokenSquared * tokens * tokens) +
    (coefficients.sampleBytesPerPixelFrame ?? 0) * size.width * size.height * size.numFrames;
  const phases: PhaseWorking['phases'] = [
    { phase: 'sample', workingBytes: sample },
    // Preparing and encoding the picture, before sampling starts.
    ...(opts.animatesPicture && coefficients.imageToVideoBytes
      ? [{ phase: 'encode' as const, workingBytes: coefficients.imageToVideoBytes }]
      : []),
    {
      phase: 'decode',
      workingBytes: decodeBytes(
        coefficients.decode[opts.vaeDecode],
        size,
        // An untiled decode has no tile to resize.
        opts.vaeDecode === 'untiled' ? 1 : (opts.decodeTileScale ?? 1),
      ),
    },
  ];
  const peak = phases.reduce((a, b) => (b.workingBytes > a.workingBytes ? b : a));
  return { phases, peak };
}

/** Adds bytes an engine holds beyond what a component's files price at. */
function withExtraBytes(weights: WeightSummary, component: string, bytes: number): WeightSummary {
  const prior = weights.byComponent.get(component);
  if (!prior || bytes <= 0) return weights;
  const byComponent = new Map(weights.byComponent);
  byComponent.set(component, {
    ...prior,
    bytes: prior.bytes + bytes,
    floorBytes: prior.floorBytes + bytes,
  });
  return summaryOf(byComponent);
}

export function videoMemoryRequirement(input: VideoMemoryInput): MediaMemoryRequirement {
  const engine = input.engine ?? 'diffusers';
  const size = input.size ?? (engine === 'sd-cpp' ? input.defaultSize : undefined);
  const streams = engine === 'diffusers' && videoStreamsComponents(input.family, input.accelerator);
  const architecture =
    input.architecture ??
    (input.family in FAMILY_KNOWN
      ? resolveVideoArchitecture({ family: input.family as VideoModelFamily })
      : undefined);
  const stored = summarizeWeights(
    input.files,
    engine === 'diffusers' ? videoFloatLoadBytes(input) : imageFloatLoadBytes(),
  );
  const weights =
    engine === 'sd-cpp' && architecture
      ? withExtraBytes(stored, 'diffusion_model', sdCppWidenedBytes(architecture))
      : stored;
  if (!size || !architecture) {
    return capToGpuLimit(
      requirementFrom(weights, input.pool, videoWorkingBytes, streams),
      engine,
      input,
    );
  }
  const geo = VIDEO_ARCHITECTURES[architecture];
  const backend = input.backend ?? input.accelerator;
  const vaeDecodeFor = (s: VideoRenderSize): VideoVaeDecode =>
    chooseVideoVaeDecode({ ...input, engine, architecture, size: s, configured: input.vaeDecode });
  const decodeTileScale =
    engine === 'sd-cpp' && input.vaeTileSizePx
      ? (input.vaeTileSizePx / SD_CPP_DEFAULT_TILE_PX) ** 2
      : 1;
  const opts = (s: VideoRenderSize) => ({
    // sd-server runs the guided and unguided passes in turn; diffusers batches them.
    batch: engine === 'sd-cpp' ? 1 : (input.guidanceScale ?? 1) > 1 ? 2 : 1,
    activationScale: engine === 'diffusers' && input.accelerator === 'cpu' ? 2 : 1,
    vaeDecode: vaeDecodeFor(s),
    decodeTileScale,
    animatesPicture: input.animatesPicture === true,
  });
  const priced = videoMemoryCoefficientCandidates(engine, backend, architecture).map(
    (coefficients) =>
      priceVideoWith(coefficients, { input, engine, backend, size, geo, weights, streams }, opts),
  );
  return priced.reduce((a, b) => (b.bytes > a.bytes ? b : a));
}

function priceVideoWith(
  coefficients: VideoMemoryCoefficients,
  ctx: {
    input: VideoMemoryInput;
    engine: VideoEngine;
    backend: MediaBackend;
    size: VideoRenderSize;
    geo: VideoArchitectureGeometry;
    weights: WeightSummary;
    streams: boolean;
  },
  opts: (s: VideoRenderSize) => {
    batch: number;
    activationScale: number;
    vaeDecode: VideoVaeDecode;
    decodeTileScale: number;
    animatesPicture: boolean;
  },
): MediaMemoryRequirement {
  const { input, engine, backend, size, geo, weights, streams } = ctx;
  const vaeDecodeFor = (s: VideoRenderSize): VideoVaeDecode => opts(s).vaeDecode;
  const atSize = phaseWorking(coefficients, geo, size, opts(size));
  const anchorSize = input.defaultSize ?? size;
  const anchorPeak = phaseWorking(coefficients, geo, anchorSize, opts(anchorSize)).peak
    .workingBytes;
  const fixedFor = (weightBytes: number): number =>
    coefficients.fixedBytes === 'anchor-legacy'
      ? Math.max(coefficients.minFixedBytes, videoWorkingBytes(weightBytes) - anchorPeak)
      : Math.max(coefficients.minFixedBytes, coefficients.fixedBytes);
  // Each phase holds its own fixed share beside its working memory; the
  // weights stay resident through all of them.
  // The load's extra followed the size of GGUF text encoders; a 16-bit
  // safetensors encoder showed none of it (see SD_CPP_METAL_LOAD_PER_ENCODER_BYTE).
  const encoderBytes = input.files
    .filter((f) => f.format === 'gguf' && componentPhase(f.component) === 'encode')
    .reduce((sum, f) => sum + f.sizeBytes, 0);
  const loadPhaseBytes =
    (coefficients.loadBytes ?? 0) + (coefficients.loadBytesPerEncoderByte ?? 0) * encoderBytes;
  const phaseTotals = (weightBytes: number) => {
    const fixed = fixedFor(weightBytes);
    return atSize.phases
      .map((p) => ({
        phase: p.phase,
        bytes:
          p.workingBytes +
          (p.phase === 'decode' && coefficients.decodeFixedBytes !== undefined
            ? coefficients.decodeFixedBytes
            : fixed),
      }))
      .concat([{ phase: 'load', bytes: loadPhaseBytes }]);
  };
  const peakOf = (weightBytes: number) =>
    phaseTotals(weightBytes).reduce((a, b) => (b.bytes > a.bytes ? b : a));
  const working = (weightBytes: number): number => {
    const fitted = peakOf(weightBytes).bytes;
    return Math.max(
      fitted * (1 + coefficients.margin.relative),
      fitted + coefficients.margin.absoluteBytes,
    );
  };

  const req = capToGpuLimit(requirementFrom(weights, input.pool, working, streams), engine, input);
  return {
    ...req,
    engine,
    backend,
    calibration: coefficients.status,
    size,
    breakdown: {
      components: [...weights.byComponent].map(([component, priced]) => ({
        component,
        bytes: Math.ceil(priced.bytes),
        phase: componentPhase(component),
      })),
      fixedBytes: Math.ceil(fixedFor(weights.total.bytes)),
      phases: atSize.phases.map((p) => ({ ...p, workingBytes: Math.ceil(p.workingBytes) })),
      peakPhase: peakOf(weights.total.bytes).phase,
      vaeDecode: vaeDecodeFor(size),
    },
  };
}

/**
 * sd.cpp's auto-fit places weights on the card up to `--max-vram` and keeps
 * the rest in system memory, so only that much must sit on the card.
 */
function capToGpuLimit(
  req: MediaMemoryRequirement,
  engine: VideoEngine,
  input: VideoMemoryInput,
): MediaMemoryRequirement {
  if (engine !== 'sd-cpp' || input.pool !== 'discrete' || input.gpuLimitBytes === undefined) {
    return req;
  }
  const limit = Math.ceil(input.gpuLimitBytes);
  return {
    ...req,
    gpuBytes: Math.min(req.gpuBytes, limit),
    gpuPeakBytes: Math.min(req.gpuPeakBytes, limit),
    floor: { ...req.floor, gpuBytes: Math.min(req.floor.gpuBytes, limit) },
  };
}

/** {@link videoMemoryRequirement} for an sd.cpp model: stored precision, priced at a size. */
export function sdCppVideoMemoryRequirement(
  input: Omit<VideoMemoryInput, 'engine' | 'vaeDtype'>,
): MediaMemoryRequirement {
  return videoMemoryRequirement({ ...input, engine: 'sd-cpp' });
}

/**
 * The decoder an sd.cpp video model loads on this backend, when its entry
 * ships both. The full Wan VAE decodes at about 80 s per million
 * pixel-frames on Metal (Wan2.2 TI2V-5B, M5 Max, 2026-11-09): hours for a
 * default 1280x704x121 clip, against well under a second for the tiny
 * decoder. Elsewhere the full VAE is the better picture. The launch and the
 * price both read this, so the engine loads what it was admitted for.
 */
export function sdCppVideoDecoder(
  roles: Iterable<string>,
  backend: MediaBackend | undefined,
): 'vae' | 'tae' | undefined {
  const present = new Set(roles);
  if (present.has('tae') && (backend === 'metal' || !present.has('vae'))) return 'tae';
  return present.has('vae') ? 'vae' : undefined;
}

/** How an sd.cpp entry decodes, in the estimator's terms. */
export function sdCppVideoVaeDecode(
  sdCpp: SdCppVideoRender | undefined,
  decoder: 'vae' | 'tae' | undefined = 'vae',
): VideoVaeDecode {
  if (decoder === 'tae') return 'tiny';
  const tiling = sdCpp?.vaeTiling;
  if (!tiling) return 'spatial';
  if (tiling.temporal) return 'temporal';
  return tiling.spatial ? 'spatial' : 'untiled';
}

/** The clip a model renders when asked for nothing in particular. */
export function videoDefaultSize(
  model: Pick<SdCppPricedVideoModel, 'defaultWidth' | 'defaultHeight' | 'defaultNumFrames'>,
): VideoRenderSize {
  return {
    width: model.defaultWidth ?? 832,
    height: model.defaultHeight ?? 480,
    numFrames: model.defaultNumFrames ?? 81,
  };
}

const SD_CPP_BACKEND_DEVICE: Readonly<Record<MediaBackend, VideoAccelerator>> = {
  metal: 'mps',
  mps: 'mps',
  cuda: 'cuda',
  vulkan: 'cuda',
  cpu: 'cpu',
};

/** What pricing reads of an sd.cpp model, whether from its catalog entry or its install record. */
export interface SdCppPricedVideoModel {
  family: string;
  architecture?: VideoArchitecture | undefined;
  sdCpp?: SdCppVideoRender | undefined;
  guidanceScale?: number | undefined;
  defaultWidth?: number | undefined;
  defaultHeight?: number | undefined;
  defaultNumFrames?: number | undefined;
}

export interface SdCppVideoModelPriceInput {
  files: readonly MediaWeightFile[];
  model: SdCppPricedVideoModel;
  pool: MediaMemoryPool;
  backend: MediaBackend;
  /** The clip to price; the model's default when absent. */
  size?: VideoRenderSize;
  /** The render animates a picture. */
  animatesPicture?: boolean;
  /** `--max-vram` on a discrete card. */
  gpuLimitBytes?: number;
}

/**
 * The one price of an sd.cpp video model: the download page passes its
 * catalog files, the launch the same files read from disk, so a model the
 * page hides is a model the launch would refuse. It prices only the decoder
 * this backend loads ({@link sdCppVideoDecoder}).
 */
export function sdCppVideoModelRequirement(
  input: SdCppVideoModelPriceInput,
): MediaMemoryRequirement {
  const defaultSize = videoDefaultSize(input.model);
  const decoder = sdCppVideoDecoder(
    input.files.map((f) => f.component),
    input.backend,
  );
  const unused = decoder === 'tae' ? 'vae' : 'tae';
  return sdCppVideoMemoryRequirement({
    files: input.files.filter((f) => f.component !== unused),
    family: input.model.family as VideoModelFamily,
    architecture: input.model.architecture,
    accelerator: SD_CPP_BACKEND_DEVICE[input.backend],
    backend: input.backend,
    pool: input.pool,
    size: input.size ?? defaultSize,
    defaultSize,
    guidanceScale: input.model.guidanceScale,
    vaeDecode: sdCppVideoVaeDecode(input.model.sdCpp, decoder),
    vaeTileSizePx: input.model.sdCpp?.vaeTiling?.tileSizePx,
    animatesPicture: input.animatesPicture,
    gpuLimitBytes: input.gpuLimitBytes,
  });
}

/**
 * The longest clip, on the VAE's frame grid within `range`, whose price
 * `accepts`; null when even `range.min` does not. Assumes the price never
 * falls as frames grow, which media-memory.test.ts pins.
 */
export function largestVideoFrames(
  architecture: VideoArchitecture,
  range: { min: number; max: number },
  priceAt: (numFrames: number) => MediaMemoryRequirement,
  accepts: (req: MediaMemoryRequirement) => boolean,
): number | null {
  const geo = VIDEO_ARCHITECTURES[architecture];
  const step = videoFrameStep(geo);
  const frames = (n: number) => n * step + 1;
  let lo = Math.ceil((Math.max(1, range.min) - 1) / step);
  let hi = (snapVideoFrames(geo, range.max) - 1) / step;
  if (lo > hi || !accepts(priceAt(frames(lo)))) return null;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (accepts(priceAt(frames(mid)))) lo = mid;
    else hi = mid - 1;
  }
  return frames(lo);
}

// ─ Image (stable-diffusion.cpp sd-server) ───────────────────────────

/**
 * Working memory over the weights, measured for every catalog model at its
 * default size on a DGX Spark (image bench, 2026-10-19;
 * docs/media-model-memory.md). It follows the output size far more than the
 * model: about 2 GiB at 512px and 3 GiB at 1024px for most models, nearly all
 * of it the CUDA context, cuBLAS workspace and process rather than the
 * engine's own compute buffers, which stay under a gigabyte. A share of the
 * weights covers the larger graphs of larger models, capped so a 46 GiB model
 * is not charged 4.6 GiB for it: uncapped, Ming was priced 5.7 GiB over its
 * measured peak.
 */
export const IMAGE_WORKING_FRACTION = 0.1;
export const IMAGE_WORKING_FRACTION_CAP_BYTES = 1.5 * GIB;
export const IMAGE_WORKING_FIXED_BYTES = 1.5 * GIB;
/** Per megapixel of output (1024x1024). */
export const IMAGE_WORKING_PER_MEGAPIXEL_BYTES = 1.5 * GIB;
/**
 * An untiled VAE decode, per megapixel: the buffer `--vae-tiling` exists to
 * split. SDXL's VAE measured 4 GiB over its tiled decode at 1024px; Krea 2's
 * Qwen-Image VAE less.
 */
export const IMAGE_UNTILED_VAE_BYTES = 4 * GIB;

/**
 * stable-diffusion.cpp keeps float32, float16 and bfloat16 weights as
 * stored, widens FP8 to float16 (ggml has no 8-bit float), and narrows
 * float64 to float32. `--tensor-type-rules` can convert a component to
 * bfloat16 at load.
 */
export function imageFloatLoadBytes(bf16Components: readonly string[] = []): FloatLoadBytes {
  return (dtype, component) => {
    if (bf16Components.includes(component)) return 2;
    if (dtype === 'F64' || dtype === 'F32') return 4;
    return 2;
  };
}

export interface ImageMemoryInput {
  files: readonly MediaWeightFile[];
  pool: MediaMemoryPool;
  /** How the launch decodes: in tiles (`--vae-tiling`), whole, or not at all (a pixel-space model). */
  vaeDecode: 'tiled' | 'untiled' | 'none';
  /** Components the launch converts to bfloat16 (`--tensor-type-rules`). */
  bf16Components?: readonly string[];
  /** Output size the price is for, in megapixels of 1024x1024. Default 1. */
  megapixels?: number;
}

export function imageMemoryRequirement(input: ImageMemoryInput): MediaMemoryRequirement {
  const megapixels = input.megapixels ?? 1;
  const untiled = input.vaeDecode === 'untiled' ? IMAGE_UNTILED_VAE_BYTES * megapixels : 0;
  return requirementFrom(
    summarizeWeights(input.files, imageFloatLoadBytes(input.bf16Components)),
    input.pool,
    (weightBytes) =>
      Math.min(weightBytes * IMAGE_WORKING_FRACTION, IMAGE_WORKING_FRACTION_CAP_BYTES) +
      IMAGE_WORKING_FIXED_BYTES +
      IMAGE_WORKING_PER_MEGAPIXEL_BYTES * megapixels +
      untiled,
    false,
  );
}

// ─ Fit ──────────────────────────────────────────────────────────────

export interface MediaCapacityCeilings {
  budgetBytes: number;
  gpuBudgetBytes: number;
}

export interface MediaCapacity extends MediaCapacityCeilings {
  pool: MediaMemoryPool;
  /**
   * The same ceilings under the engine memory limit the person set in
   * Settings, when that is lower than the machine's automatic budget.
   */
  limit?: MediaCapacityCeilings;
  totalRamBytes: number;
  /** Total memory of the single card a media engine runs on, for a discrete pool. */
  gpuDeviceBytes?: number;
}

/** What the OS keeps whatever else happens — the ledger's own floor reserve. */
const OS_FLOOR_RESERVE_BYTES = 4 * GIB;

/** The device ledger's static refusal, mirrored: its acquire check, before any queueing. */
function ledgerRefuses(r: MediaMemoryFigures, c: MediaCapacityCeilings): boolean {
  return r.bytes > c.budgetBytes || r.gpuBytes > c.gpuBudgetBytes;
}

/** Weights larger than the physical memory they must sit in. */
function physicallyImpossible(r: MediaMemoryFigures, cap: MediaCapacity): boolean {
  if (
    cap.pool === 'discrete' &&
    cap.gpuDeviceBytes !== undefined &&
    r.gpuBytes > cap.gpuDeviceBytes
  )
    return true;
  const inRam = cap.pool === 'discrete' ? r.weightBytes - r.gpuBytes : r.weightBytes;
  return inRam > cap.totalRamBytes - OS_FLOOR_RESERVE_BYTES;
}

function formatGb(bytes: number): string {
  const gb = bytes / GIB;
  return `${gb < 10 ? gb.toFixed(1).replace(/\.0$/, '') : Math.round(gb)} GB`;
}

/**
 * The verdict for one model on this machine. `wont-run` is reserved for what
 * is certain: the daemon's own admission check refuses the model's smallest
 * plausible requirement at the machine's full budget, or its weights exceed
 * the physical memory they must sit in. Everything uncertain is a warning.
 */
export function assessMediaFit(
  req: MediaMemoryRequirement,
  cap: MediaCapacity,
): MediaFitAssessment {
  const gpuAvailable =
    cap.pool === 'discrete' && cap.gpuDeviceBytes !== undefined
      ? Math.min(cap.gpuBudgetBytes, cap.gpuDeviceBytes)
      : cap.gpuBudgetBytes;
  const totalAvailable =
    cap.pool === 'unified' ? Math.min(cap.budgetBytes, cap.gpuBudgetBytes) : cap.budgetBytes;
  const onCard = (r: MediaMemoryFigures, ceiling: number) =>
    cap.pool === 'discrete' && r.gpuBytes > ceiling;

  const result = (
    verdict: MediaFitVerdict,
    neededBytes: number,
    availableBytes: number,
    reason: string,
  ): MediaFitAssessment => ({
    verdict,
    pool: req.pool,
    weightBytes: req.weightBytes,
    bytes: req.bytes,
    gpuBytes: req.gpuBytes,
    exact: req.exact,
    neededBytes,
    availableBytes,
    reason,
  });

  if (ledgerRefuses(req.floor, cap) || physicallyImpossible(req.floor, cap)) {
    if (onCard(req.floor, gpuAvailable)) {
      return result(
        'wont-run',
        req.floor.gpuBytes,
        gpuAvailable,
        `Its weights need about ${formatGb(req.floor.gpuBytes)} of graphics memory; Gezel can use about ${formatGb(gpuAvailable)} of this card.`,
      );
    }
    return result(
      'wont-run',
      req.floor.bytes,
      totalAvailable,
      `It needs about ${formatGb(req.floor.bytes)} of memory while generating; Gezel can use about ${formatGb(totalAvailable)} on this machine.`,
    );
  }
  if (ledgerRefuses(req, cap) || physicallyImpossible(req, cap)) {
    const gpuBound = onCard(req, gpuAvailable);
    const needed = gpuBound ? req.gpuBytes : req.bytes;
    const available = gpuBound ? gpuAvailable : totalAvailable;
    return result(
      'may-not-run',
      needed,
      available,
      `It probably needs about ${formatGb(needed)}${gpuBound ? ' of graphics memory' : ''}, and Gezel can use about ${formatGb(available)} here. Its catalog entry does not say its exact size.`,
    );
  }
  if (cap.limit && ledgerRefuses(req, cap.limit)) {
    const gpuBound = req.gpuBytes > cap.limit.gpuBudgetBytes;
    const needed = gpuBound ? req.gpuBytes : req.bytes;
    const available = gpuBound ? cap.limit.gpuBudgetBytes : cap.limit.budgetBytes;
    return result(
      'over-limit',
      needed,
      available,
      `It needs about ${formatGb(needed)}, more than the ${formatGb(available)} engine memory limit set in Settings.`,
    );
  }
  if (cap.pool === 'discrete' && req.gpuPeakBytes > gpuAvailable) {
    return result(
      'tight',
      req.gpuPeakBytes,
      gpuAvailable,
      `Its weights fit the ${formatGb(gpuAvailable)} of this card Gezel can use, but generating may run out of graphics memory (about ${formatGb(req.gpuPeakBytes)} at its default size).`,
    );
  }
  // What the page shows a person: the card's whole share on a discrete GPU,
  // not just its weights.
  return cap.pool === 'discrete'
    ? result('fits', req.gpuPeakBytes, gpuAvailable, '')
    : result('fits', req.bytes, totalAvailable, '');
}
