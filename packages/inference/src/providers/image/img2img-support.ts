/**
 * Per-model image-editing capability for the local sd-cpp engine: whether a
 * model re-noises a source (img2img), reads sources as references beside an
 * instruction, or cannot use one. The img2img half first.
 *
 * stable-diffusion.cpp's `/sdapi/v1/img2img` endpoint accepts
 * `init_images` for any loaded model, but whether the *architecture*
 * actually honors the init latents varies: the classic SD 1.x / SDXL
 * denoising path is mature, while newer diffusion-model architectures
 * (FLUX.2's LLM-encoder family, Krea 2's Qwen-Image lineage) are unverified on
 * the pinned sd-server — the same server build that already ignores
 * per-request step overrides for Krea (see MODEL_SAMPLE_STEP_DEFAULTS).
 *
 * Resolution ladder, most explicit wins:
 *   1. `supportsImg2Img` declared on the catalog manifest (persisted
 *      into the installed `manifest.json` at pull time),
 *   2. the assessment map below (repo-local truth for shipped models,
 *      same pattern as MODEL_CFG_DEFAULTS),
 *   3. a `weightsKind` default: `checkpoint` (and unknown/legacy
 *      installs, which are all SD-era checkpoints) → supported;
 *      `diffusion-model` → not supported until assessed.
 *
 * When a model resolves unsupported, callers drop the input images and
 * report `img2imgSkippedReason` instead of silently producing an
 * "edit" that never saw the source image. Flip a map entry (or set the
 * catalog field) after verifying a family on real hardware.
 */

export const MODEL_IMG2IMG_SUPPORT = new Map<string, boolean>([
  // Classic SD checkpoints — the original, well-exercised img2img path.
  ['sd-1.5', true],
  ['sd-turbo', true],
  ['sdxl-base-1.0', true],
  ['sdxl-turbo', true],
  ['sdxl-lightning-4step', true],
  ['animagine-xl-4', true],
  // FLUX.1 — img2img documented working in upstream stable-diffusion.cpp.
  // Still in the pinned catalog and on people's disks.
  ['flux-1-schnell-q4', true],
  ['flux-1-dev-q4', true],
  // FLUX.2 Klein — LLM-text-encoder flow model; img2img unverified on the
  // pinned sd-server. Treat as txt2img-only until assessed.
  ['flux-2-klein-4b-q4', false],
  // Krea 2 Turbo — Qwen-Image architecture; the pinned server already has
  // known per-request gaps for these models (steps override ignored).
  ['krea-2-turbo-q4', false],
  ['krea-2-turbo-q6', false],
  ['krea-2-turbo-q8', false],
]);

export interface Img2ImgSupportInput {
  /** Resolved model id; undefined when nothing is installed. */
  modelId?: string | undefined;
  /** Explicit capability from catalog/installed metadata, when declared. */
  explicit?: boolean | undefined;
  /** Loading shape from installed metadata, when recorded. */
  weightsKind?: 'checkpoint' | 'diffusion-model' | undefined;
}

export interface Img2ImgSupportVerdict {
  supported: boolean;
  /** Human-readable reason, set only when unsupported. */
  reason?: string;
}

/**
 * Models that edit by reading source pictures as references beside an
 * instruction (sd-server's `extra_images`), rather than re-noising one. The
 * same ladder as above: a catalog `referenceImages` declaration persisted at
 * pull time wins, then this map, which is how installs that predate the
 * field learn it.
 *
 * FLUX.2 Klein: verified on the pinned engine (native sd-cpp master-975) on
 * an RTX Spark, 2026-10-27, recoloring, adding an object and composing two
 * sources at 4 steps in 12 s.
 */
export const MODEL_REFERENCE_EDIT_SUPPORT = new Map<
  string,
  { maxImages: number; editOnly?: boolean }
>([
  ['flux-2-klein-4b-q4', { maxImages: 3 }],
  ['qwen-image-edit-2511-q4', { maxImages: 3, editOnly: true }],
]);

export interface ImageEditCapabilityInput extends Img2ImgSupportInput {
  /** Explicit `referenceImages` from catalog/installed metadata. */
  referenceImages?: { max: number } | undefined;
  /** Explicit `editOnly` from catalog/installed metadata. */
  editOnly?: boolean | undefined;
}

export interface ImageEditCapability {
  /** Absent when the model cannot use a source picture at all. */
  editMode?: 'reference' | 'img2img';
  /** Sources one edit takes: the reference limit, or 1 for img2img. */
  maxSourceImages?: number;
  editOnly: boolean;
  /** Why the model cannot edit; set only when `editMode` is absent. */
  reason?: string;
}

export function resolveImageEditCapability(input: ImageEditCapabilityInput): ImageEditCapability {
  const assessed = input.modelId ? MODEL_REFERENCE_EDIT_SUPPORT.get(input.modelId) : undefined;
  const editOnly = input.editOnly ?? assessed?.editOnly ?? false;
  const maxImages = input.referenceImages?.max ?? assessed?.maxImages;
  if (maxImages !== undefined) {
    return { editMode: 'reference', maxSourceImages: maxImages, editOnly };
  }
  const img2img = resolveImg2ImgSupport(input);
  if (img2img.supported) return { editMode: 'img2img', maxSourceImages: 1, editOnly };
  return { editOnly, ...(img2img.reason ? { reason: img2img.reason } : {}) };
}

export function resolveImg2ImgSupport(input: Img2ImgSupportInput): Img2ImgSupportVerdict {
  if (input.explicit !== undefined) {
    return input.explicit
      ? { supported: true }
      : {
          supported: false,
          reason: `model ${input.modelId ?? 'unknown'} does not support image editing (img2img)`,
        };
  }
  if (input.modelId !== undefined) {
    const assessed = MODEL_IMG2IMG_SUPPORT.get(input.modelId);
    if (assessed !== undefined) {
      return assessed
        ? { supported: true }
        : {
            supported: false,
            reason: `model ${input.modelId} does not support image editing (img2img) on the bundled engine`,
          };
    }
  }
  if (input.weightsKind === 'diffusion-model') {
    return {
      supported: false,
      reason: `model ${input.modelId ?? 'unknown'} has not been verified for image editing (img2img) on the bundled engine`,
    };
  }
  return { supported: true };
}
