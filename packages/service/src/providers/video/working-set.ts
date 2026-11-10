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

import { stat } from 'node:fs/promises';
import {
  type MediaMemoryPool,
  type MediaMemoryRequirement,
  type MediaWeightFile,
  type SdCppPricedVideoModel,
  type SdCppVideoModelPriceInput,
  type VideoAccelerator,
  sdCppVideoModelRequirement,
  videoMemoryRequirement,
  weightFileFormat,
} from '@bendyline/gezel';
import { localDiffusersWeightFiles, readLocalWeightTensors } from '../../models/weight-facts.js';
import type { InstalledVideoModel } from './models.js';

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

/** An installed sd.cpp model's weight files, each priced as the sd-server slot it fills. */
export async function localSdCppVideoWeightFiles(
  components: NonNullable<InstalledVideoModel['components']>,
): Promise<MediaWeightFile[]> {
  return Promise.all(
    components.map(async ({ role, path }): Promise<MediaWeightFile> => {
      const format = weightFileFormat(path) ?? 'opaque';
      const sizeBytes = (await stat(path)).size;
      const tensors = format === 'safetensors' ? await readLocalWeightTensors(path) : undefined;
      return { component: role, sizeBytes, format, ...(tensors ? { tensors } : {}) };
    }),
  );
}

/** What sd-server needs for one installed sd.cpp video model, from its files on disk. */
export async function estimateSdCppVideoRequirement(
  input: Omit<SdCppVideoModelPriceInput, 'files' | 'model'> & {
    model: SdCppPricedVideoModel & Pick<InstalledVideoModel, 'components'>;
  },
): Promise<MediaMemoryRequirement> {
  return sdCppVideoModelRequirement({
    ...input,
    files: await localSdCppVideoWeightFiles(input.model.components ?? []),
  });
}
