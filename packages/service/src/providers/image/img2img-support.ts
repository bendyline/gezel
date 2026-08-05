/**
 * Per-model img2img capability resolution for the local sd-cpp engine.
 *
 * stable-diffusion.cpp's `/sdapi/v1/img2img` endpoint accepts
 * `init_images` for any loaded model, but whether the *architecture*
 * actually honors the init latents varies: the classic SD 1.x / SDXL
 * denoising path is mature, FLUX.1's flow-matching img2img is supported
 * upstream, while newer diffusion-model architectures (FLUX.2's
 * LLM-encoder family, Krea 2's Qwen-Image lineage) are unverified on
 * the pinned sd-server — the same server build that already ignores
 * per-request step overrides for Krea (see DISTILLED_MODEL_SAMPLE_STEPS).
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
