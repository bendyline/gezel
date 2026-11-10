/**
 * "Can this machine run that media model?" for the image and video catalogs.
 *
 * Prices each catalog entry from the weight facts its gilde entry pins (core
 * `media-memory.ts`) — never the network — and checks it against the same
 * static ceilings the device ledger refuses at, so `wont-run` here means the
 * launch path would refuse the model on this machine whatever else is
 * running. The download pages hide those models and the pull routes refuse
 * them. Contract: docs/media-model-memory.md.
 *
 * The image half lives in inference beside the image engine, so hosted
 * inference answers the same fit; video stays here with its engine.
 */

import {
  type MediaBackend,
  type MediaFitAssessment,
  type MediaMemoryPool,
  type MediaModelFitResponse,
  type VideoAccelerator,
  type VideoModelManifest,
  assessMediaFit,
  sdCppVideoModelRequirement,
  videoMemoryRequirement,
} from '@bendyline/gezel';
import {
  type FitPlan,
  type MediaFitContext,
  imageMediaPool,
  mediaCapacity,
  mediaFitResponse,
  sdServerBackend,
} from '@bendyline/gezel-inference/internal/models/image-fit';
import type { CapacityBudgetKind } from '@bendyline/gezel-inference/internal/providers/native/capacity-budget';
import { measuredCapacityBudget } from '@bendyline/gezel-inference/internal/providers/native/measured-budget';
import { detectVideoAccelerator } from '../providers/video/venv.js';
import { videoCatalogWeightFiles } from './weight-facts.js';

export {
  type MediaFitContext,
  imageCatalogFits,
  imageMediaPool,
  imageModelFit,
  imageRenderMegapixels,
  mediaCapacity,
  sdServerLedgerClaim,
  sdServerRequirement,
  wontRunRefusal,
} from '@bendyline/gezel-inference/internal/models/image-fit';

/** Where the video engine keeps weights: its accelerator, and whether that card shares RAM. */
export function videoMediaPool(
  accelerator: VideoAccelerator,
  kind: CapacityBudgetKind,
): MediaMemoryPool {
  if (accelerator === 'cpu') return 'cpu';
  if (accelerator === 'mps') return 'unified';
  return kind === 'unified' ? 'unified' : 'discrete';
}

interface VideoFitPlan extends FitPlan {
  accelerator: VideoAccelerator;
  /** The sd.cpp engine runs where the image engine does, with its own pool and backend. */
  sdCpp: FitPlan & { backend: MediaBackend; fastBytes: number };
}

async function videoPlan(ctx: MediaFitContext): Promise<VideoFitPlan> {
  const [accelerator, budget] = await Promise.all([
    detectVideoAccelerator(),
    measuredCapacityBudget(),
  ]);
  const pool = videoMediaPool(accelerator, budget.kind);
  const sdPool = imageMediaPool(budget.kind);
  const [capacity, sdCapacity] = await Promise.all([
    mediaCapacity(pool, ctx.readConfig),
    sdPool === pool ? undefined : mediaCapacity(sdPool, ctx.readConfig),
  ]);
  return {
    pool,
    accelerator,
    capacity,
    sdCpp: {
      pool: sdPool,
      capacity: sdCapacity ?? capacity,
      backend: sdServerBackend(),
      fastBytes: budget.fastBytes,
    },
  };
}

function assessVideoManifest(plan: VideoFitPlan, manifest: VideoModelManifest): MediaFitAssessment {
  const files = videoCatalogWeightFiles(manifest);
  if (manifest.engine === 'sd-cpp') {
    const sd = plan.sdCpp;
    return assessMediaFit(
      sdCppVideoModelRequirement({
        files,
        model: manifest,
        pool: sd.pool,
        backend: sd.backend,
        ...(sd.pool === 'discrete' ? { gpuLimitBytes: sd.fastBytes } : {}),
      }),
      sd.capacity,
    );
  }
  return assessMediaFit(
    videoMemoryRequirement({
      files,
      family: manifest.family,
      accelerator: plan.accelerator,
      pool: plan.pool,
      vaeDtype: manifest.load?.vaeDtype,
    }),
    plan.capacity,
  );
}

export async function videoCatalogFits(ctx: MediaFitContext): Promise<MediaModelFitResponse> {
  const plan = await videoPlan(ctx);
  const items = await ctx.catalog.list('video-model');
  const models = items
    .map((item) => item.manifest)
    .filter((m): m is VideoModelManifest => m.kind === 'video-model')
    .map((m) => ({ id: m.id, ...assessVideoManifest(plan, m) }));
  return mediaFitResponse(plan, models);
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
