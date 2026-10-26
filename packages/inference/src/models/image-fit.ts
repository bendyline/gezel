/**
 * "Can this machine run that image model?" for the image catalog.
 *
 * Prices each catalog entry from the weight facts its gilde entry pins (core
 * `media-memory.ts`) — never the network — and checks it against the same
 * static ceilings the device ledger refuses at, so `wont-run` here means the
 * launch path would refuse the model on this machine whatever else is
 * running. The download pages hide those models and the pull routes refuse
 * them. Contract: docs/media-model-memory.md.
 *
 * The video half lives with the video engine in the service, which shares
 * the helpers here.
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
  assessMediaFit,
  createLogger,
  imageMemoryRequirement,
  imageModelDefaultSide,
  resolveImageSize,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { isCudaArchivePath } from '@bendyline/gezel/native';
import { sdServerLoadProfile } from '../providers/image/sd-cpp.js';
import type { CapacityBudgetKind } from '../providers/native/capacity-budget.js';
import {
  configuredEngineMemoryBytes,
  staticCapacityCeilings,
} from '../providers/native/device-capacity.js';
import { measuredCapacityBudget } from '../providers/native/measured-budget.js';
import { detectMemoryProfileCached } from '../system/memory.js';
import { imageCatalogWeightFiles, sdCppMainComponent } from './weight-facts.js';

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

/**
 * What a launched sd-server claims on the device ledger.
 *
 * On a discrete card the fit figures charge graphics memory for weights only,
 * because sd-server can stream components from RAM, and the download page
 * must not call a model that offloads "won't run". A running render holds its
 * compute buffers on the card too, though: FLUX.2 Klein at 1024px held
 * 9.4 GiB of a 12 GiB card's dedicated memory against 4.9 GiB of weights
 * (RTX 5070 Ti Laptop, Vulkan, M0 spike 2026-10-25). Claiming weights only
 * let a resident chat model keep its memory, and the render then failed at
 * its first step. The claim is the estimated peak, capped at the card so a
 * model that must offload is admitted once the card is otherwise free.
 */
export function sdServerLedgerClaim(
  requirement: MediaMemoryRequirement,
  cardBytes: number,
): { bytes: number; gpuBytes: number } {
  if (requirement.pool !== 'discrete') {
    return { bytes: requirement.bytes, gpuBytes: requirement.gpuBytes };
  }
  const gpuBytes = Math.min(Math.max(requirement.gpuPeakBytes, requirement.gpuBytes), cardBytes);
  return { bytes: Math.max(requirement.bytes, gpuBytes), gpuBytes };
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

export interface FitPlan {
  pool: MediaMemoryPool;
  capacity: MediaCapacity;
}

async function imagePlan(ctx: MediaFitContext): Promise<FitPlan> {
  const budget = await measuredCapacityBudget();
  const pool = imageMediaPool(budget.kind);
  return { pool, capacity: await mediaCapacity(pool, ctx.readConfig) };
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

export function mediaFitResponse(plan: FitPlan, models: MediaModelFit[]): MediaModelFitResponse {
  return {
    pool: plan.pool,
    budgetBytes: plan.capacity.budgetBytes,
    gpuBudgetBytes: plan.capacity.gpuBudgetBytes,
    totalRamBytes: plan.capacity.totalRamBytes,
    models,
  };
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
  return mediaFitResponse(plan, models);
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
