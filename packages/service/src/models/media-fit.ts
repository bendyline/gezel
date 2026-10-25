/**
 * "Can this machine run that media model?" for the image and video catalogs.
 *
 * Prices each catalog entry from the weight facts its gilde entry pins (core
 * `media-memory.ts`) — never the network — and checks it against the same
 * static ceilings the device ledger refuses at, so `wont-run` here means the
 * launch path would refuse the model on this machine whatever else is
 * running. The download pages hide those models and the pull routes refuse
 * them. Contract: docs/media-model-memory.md.
 */

import { totalmem } from 'node:os';
import {
  type GezelConfig,
  type ImageModelManifest,
  type ImageQuality,
  MEDIA_MODEL_WONT_RUN_CODE,
  type MediaCapacity,
  type MediaFitAssessment,
  type MediaMemoryPool,
  type MediaMemoryRequirement,
  type MediaModelFit,
  type MediaModelFitResponse,
  type MediaWeightFile,
  type VideoAccelerator,
  type VideoModelManifest,
  assessMediaFit,
  createLogger,
  imageMemoryRequirement,
  imageModelDefaultSide,
  resolveImageSize,
  videoMemoryRequirement,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { CapacityBudgetKind } from '@bendyline/gezel-inference/internal/providers/native/capacity-budget';
import {
  configuredEngineMemoryBytes,
  staticCapacityCeilings,
} from '@bendyline/gezel-inference/internal/providers/native/device-capacity';
import { measuredCapacityBudget } from '@bendyline/gezel-inference/internal/providers/native/measured-budget';
import { detectMemoryProfileCached } from '@bendyline/gezel-inference/internal/system/memory';
import { isCudaArchivePath } from '@bendyline/gezel/native';
import { sdServerLoadProfile } from '../providers/image/sd-cpp.js';
import { detectVideoAccelerator } from '../providers/video/venv.js';
import {
  imageCatalogWeightFiles,
  sdCppMainComponent,
  videoCatalogWeightFiles,
} from './weight-facts.js';

const log = createLogger('media-fit');

export interface MediaFitContext {
  catalog: CatalogService;
  readConfig: () => Promise<Pick<GezelConfig, 'localEngineMemoryGb'>>;
}

/**
 * The 409 body a pull route answers with when the model cannot run here, or
 * null to let the pull start. A failure to assess never blocks a download:
 * the launch path still applies the same check.
 */
export async function wontRunRefusal(
  assess: () => Promise<MediaFitAssessment | null>,
): Promise<{ error: string; code: string } | null> {
  try {
    const fit = await assess();
    if (fit?.verdict !== 'wont-run') return null;
    return {
      error: `This model is too large for this machine. ${fit.reason}`,
      code: MEDIA_MODEL_WONT_RUN_CODE,
    };
  } catch (error) {
    log.warn(
      `[media-fit] could not assess a pull, letting it start: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/** Where the video engine keeps weights: its accelerator, and whether that card shares RAM. */
export function videoMediaPool(
  accelerator: VideoAccelerator,
  kind: CapacityBudgetKind,
): MediaMemoryPool {
  if (accelerator === 'cpu') return 'cpu';
  if (accelerator === 'mps') return 'unified';
  return kind === 'unified' ? 'unified' : 'discrete';
}

/**
 * Where sd-server keeps weights: Metal on Apple Silicon, CPU on Intel Macs,
 * CUDA or Vulkan elsewhere, falling back to the processor when no GPU
 * answers. Windows on Arm runs on the processor unless discovery picked its
 * CUDA build, which only an RTX Spark gets.
 */
export function imageMediaPool(
  kind: CapacityBudgetKind,
  host: { platform: NodeJS.Platform; arch: string; sdServerBin?: string | undefined } = {
    platform: process.platform,
    arch: process.arch,
    sdServerBin: process.env.GEZEL_SD_SERVER_BIN,
  },
): MediaMemoryPool {
  if (host.platform === 'darwin') return host.arch === 'arm64' ? 'unified' : 'cpu';
  if (
    host.platform === 'win32' &&
    host.arch === 'arm64' &&
    !(host.sdServerBin && isCudaArchivePath(host.sdServerBin))
  ) {
    return 'cpu';
  }
  return kind === 'discrete-gpu' ? 'discrete' : kind === 'unified' ? 'unified' : 'cpu';
}

/** The ceilings the device ledger applies on this machine, automatic and under the person's limit. */
export async function mediaCapacity(
  pool: MediaMemoryPool,
  readConfig: MediaFitContext['readConfig'],
): Promise<MediaCapacity> {
  const budget = await measuredCapacityBudget();
  const ram = totalmem();
  const auto = staticCapacityCeilings(budget, ram);
  const configured = configuredEngineMemoryBytes(await readConfig().catch(() => ({})));
  const limited =
    configured === undefined ? undefined : staticCapacityCeilings(budget, ram, configured);
  const profile = pool === 'discrete' ? await detectMemoryProfileCached().catch(() => null) : null;
  return {
    pool,
    ...auto,
    ...(limited && limited.budgetBytes < auto.budgetBytes ? { limit: limited } : {}),
    totalRamBytes: ram,
    ...(profile?.gpuLargestDeviceBytes ? { gpuDeviceBytes: profile.gpuLargestDeviceBytes } : {}),
  };
}

/** The memory sd-server needs for one model, from its weight files and its launch profile. */
export function sdServerRequirement(input: {
  modelId: string;
  weightsKind: 'checkpoint' | 'diffusion-model';
  files: readonly MediaWeightFile[];
  pool: MediaMemoryPool;
  /** The render size to price; the model's default size when absent. */
  megapixels?: number;
}): MediaMemoryRequirement {
  const profile = sdServerLoadProfile(input.modelId);
  return imageMemoryRequirement({
    files: input.files,
    pool: input.pool,
    vaeDecode: profile.vaeDecode,
    // The rule names the diffusion weights, which are the main file.
    bf16Components: profile.bf16TensorPattern ? [sdCppMainComponent(input.weightsKind)] : [],
    megapixels: input.megapixels ?? profile.defaultSidePx ** 2 / 1024 ** 2,
  });
}

/** Megapixels a model renders at a quality tier, inside its range. */
export function imageRenderMegapixels(
  manifest: Pick<ImageModelManifest, 'id' | 'widthRange' | 'heightRange'>,
  quality: ImageQuality,
): number {
  const { width, height } = resolveImageSize(
    { quality },
    {
      defaultSidePx: imageModelDefaultSide(manifest.id),
      widthRange: manifest.widthRange,
      heightRange: manifest.heightRange,
    },
  );
  return (width * height) / 1024 ** 2;
}

interface FitPlan {
  pool: MediaMemoryPool;
  capacity: MediaCapacity;
}

interface VideoFitPlan extends FitPlan {
  accelerator: VideoAccelerator;
}

async function videoPlan(ctx: MediaFitContext): Promise<VideoFitPlan> {
  const [accelerator, budget] = await Promise.all([
    detectVideoAccelerator(),
    measuredCapacityBudget(),
  ]);
  const pool = videoMediaPool(accelerator, budget.kind);
  return { pool, accelerator, capacity: await mediaCapacity(pool, ctx.readConfig) };
}

async function imagePlan(ctx: MediaFitContext): Promise<FitPlan> {
  const budget = await measuredCapacityBudget();
  const pool = imageMediaPool(budget.kind);
  return { pool, capacity: await mediaCapacity(pool, ctx.readConfig) };
}

function assessVideoManifest(plan: VideoFitPlan, manifest: VideoModelManifest): MediaFitAssessment {
  return assessMediaFit(
    videoMemoryRequirement({
      files: videoCatalogWeightFiles(manifest),
      family: manifest.family,
      accelerator: plan.accelerator,
      pool: plan.pool,
      vaeDtype: manifest.load?.vaeDtype,
    }),
    plan.capacity,
  );
}

function assessImageManifest(
  plan: FitPlan,
  manifest: ImageModelManifest,
  quality?: ImageQuality,
): MediaFitAssessment {
  return assessMediaFit(
    sdServerRequirement({
      modelId: manifest.id,
      weightsKind: manifest.weightsKind,
      files: imageCatalogWeightFiles(manifest),
      pool: plan.pool,
      ...(quality ? { megapixels: imageRenderMegapixels(manifest, quality) } : {}),
    }),
    plan.capacity,
  );
}

function response(plan: FitPlan, models: MediaModelFit[]): MediaModelFitResponse {
  return {
    pool: plan.pool,
    budgetBytes: plan.capacity.budgetBytes,
    gpuBudgetBytes: plan.capacity.gpuBudgetBytes,
    totalRamBytes: plan.capacity.totalRamBytes,
    models,
  };
}

export async function videoCatalogFits(ctx: MediaFitContext): Promise<MediaModelFitResponse> {
  const plan = await videoPlan(ctx);
  const items = await ctx.catalog.list('video-model');
  const models = items
    .map((item) => item.manifest)
    .filter((m): m is VideoModelManifest => m.kind === 'video-model')
    .map((m) => ({ id: m.id, ...assessVideoManifest(plan, m) }));
  return response(plan, models);
}

/**
 * Every catalog image model's fit. With `quality`, each is priced at the size
 * it renders at that tier rather than its default, which is how the direct
 * image gezel's settings know whether High will fit.
 */
export async function imageCatalogFits(
  ctx: MediaFitContext,
  quality?: ImageQuality,
): Promise<MediaModelFitResponse> {
  const plan = await imagePlan(ctx);
  const items = await ctx.catalog.list('image-model');
  const models = items
    .map((item) => item.manifest)
    .filter((m): m is ImageModelManifest => m.kind === 'image-model')
    .map((m) => ({ id: m.id, ...assessImageManifest(plan, m, quality) }));
  return response(plan, models);
}

/** One catalog video model's fit, or null when the id is not in the catalog. */
export async function videoModelFit(
  ctx: MediaFitContext,
  id: string,
): Promise<MediaFitAssessment | null> {
  const item = await ctx.catalog.get('video-model', id);
  if (!item || item.manifest.kind !== 'video-model') return null;
  return assessVideoManifest(await videoPlan(ctx), item.manifest);
}

/** One catalog image model's fit, or null when the id is not in the catalog. */
export async function imageModelFit(
  ctx: MediaFitContext,
  id: string,
): Promise<MediaFitAssessment | null> {
  const item = await ctx.catalog.get('image-model', id);
  if (!item || item.manifest.kind !== 'image-model') return null;
  return assessImageManifest(await imagePlan(ctx), item.manifest);
}
