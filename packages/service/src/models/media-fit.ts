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
  type MediaFitAssessment,
  type MediaMemoryPool,
  type MediaModelFitResponse,
  type VideoAccelerator,
  type VideoModelManifest,
  assessMediaFit,
  videoMemoryRequirement,
} from '@bendyline/gezel';
import {
  type FitPlan,
  type MediaFitContext,
  mediaCapacity,
  mediaFitResponse,
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
}

async function videoPlan(ctx: MediaFitContext): Promise<VideoFitPlan> {
  const [accelerator, budget] = await Promise.all([
    detectVideoAccelerator(),
    measuredCapacityBudget(),
  ]);
  const pool = videoMediaPool(accelerator, budget.kind);
  return { pool, accelerator, capacity: await mediaCapacity(pool, ctx.readConfig) };
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
