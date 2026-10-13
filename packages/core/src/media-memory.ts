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
import type { WeightTensors } from './schemas/catalog.js';
import type { MediaFitAssessment, MediaFitVerdict, MediaMemoryPool } from './schemas/media-fit.js';
import type { VideoAccelerator } from './schemas/video.js';

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
  accelerator: VideoAccelerator;
  pool: MediaMemoryPool;
  vaeDtype?: 'float32' | 'bfloat16' | undefined;
}

export function videoMemoryRequirement(input: VideoMemoryInput): MediaMemoryRequirement {
  return requirementFrom(
    summarizeWeights(input.files, videoFloatLoadBytes(input)),
    input.pool,
    videoWorkingBytes,
    videoStreamsComponents(input.family, input.accelerator),
  );
}

// ─ Image (stable-diffusion.cpp sd-server) ───────────────────────────

/**
 * Working memory over the weights: the diffusion compute buffer plus a tiled
 * VAE decode. Not yet measured per model (docs/media-model-memory.md); sized
 * from sd.cpp's own buffer reports, which run 1-3 GB at 1024px.
 */
export const IMAGE_WORKING_FRACTION = 0.1;
export const IMAGE_WORKING_FIXED_BYTES = 1.5 * GIB;
/** An untiled VAE decode at 1024px: the single buffer `--vae-tiling` exists to split. */
export const IMAGE_UNTILED_VAE_BYTES = 6 * GIB;

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
}

export function imageMemoryRequirement(input: ImageMemoryInput): MediaMemoryRequirement {
  const untiled = input.vaeDecode === 'untiled' ? IMAGE_UNTILED_VAE_BYTES : 0;
  return requirementFrom(
    summarizeWeights(input.files, imageFloatLoadBytes(input.bf16Components)),
    input.pool,
    (weightBytes) => weightBytes * IMAGE_WORKING_FRACTION + IMAGE_WORKING_FIXED_BYTES + untiled,
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
