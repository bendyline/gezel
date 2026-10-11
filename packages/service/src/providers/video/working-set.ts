/**
 * Memory the video engine needs for one installed model: its weight files
 * read from disk, priced by core `videoMemoryRequirement` at the precision
 * `gezel_video_server.py` loads them in. The download page priced the same
 * files from their published headers before the model was downloaded, so the
 * launch admits exactly what the page offered.
 *
 * The generic native estimate (weight bytes on disk x 1.5) is built for LLM
 * engines and badly overprices a diffusers tree: LTX-2.x ships its Gemma 3
 * text encoder as 49 GB of float32 that loads as 24 GB of bfloat16, and a
 * diffusion model has no KV cache to reserve for. The generic figure for
 * LTX-2.3 was ~143 GiB, which a 128 GB Mac refused outright, while the
 * pipeline's measured peak (89-91 GiB) fits its 96 GiB GPU budget.
 */

import {
  type MediaMemoryPool,
  type MediaMemoryRequirement,
  type VideoAccelerator,
  videoMemoryRequirement,
} from '@bendyline/gezel';
import { localDiffusersWeightFiles } from '../../models/weight-facts.js';

export interface VideoRequirementInput {
  modelDir: string;
  family: string;
  accelerator: VideoAccelerator;
  pool: MediaMemoryPool;
  vaeDtype?: 'float32' | 'bfloat16';
}

export async function estimateVideoRequirement(
  input: VideoRequirementInput,
): Promise<MediaMemoryRequirement> {
  return videoMemoryRequirement({
    files: await localDiffusersWeightFiles(input.modelDir),
    family: input.family,
    accelerator: input.accelerator,
    pool: input.pool,
    vaeDtype: input.vaeDtype,
  });
}
