import { aspectRatioValue } from '@bendyline/gezel';
import { readImageMeta } from '@bendyline/gezel-inference/internal/utils/image-meta';
import { type RpcRecord, record } from './codex-image-client.js';
import type { ImageGenerationInput } from './types.js';

export const CODEX_IMAGE_MODEL = 'codex-image';

/** The CLI exposes a native image tool through a model turn, not an image-parameter RPC. */
export function codexImageSettings(input: ImageGenerationInput) {
  if (!input.prompt.trim() || input.prompt.length > 32_000)
    throw new Error('Codex image prompts must contain 1–32,000 characters.');
  if (input.model?.trim() && input.model.trim() !== CODEX_IMAGE_MODEL)
    throw new Error(
      'Codex chooses its image model. Select Codex image generation or leave the model unset.',
    );
  const notes: string[] = [];
  if (input.width !== undefined || input.height !== undefined || input.aspectRatio || input.quality)
    notes.push(
      'Size, aspect ratio, and quality were requested in the image brief; Codex controls the final render settings.',
    );
  if (input.negativePrompt?.trim())
    notes.push(
      'The negative prompt was included as instructions; Codex has no separate negative-prompt control.',
    );
  if (input.strength !== undefined)
    notes.push(
      'Edit strength was described in the image brief; Codex has no numeric edit-strength control.',
    );
  if (input.seed !== undefined)
    notes.push('Codex does not expose a reproducible seed; the requested seed was not applied.');
  if (input.steps !== undefined)
    notes.push('Codex manages sampling steps; the requested step count was not applied.');
  return {
    prompt: `Generate exactly one PNG image using the native image generation tool. Apply the following image brief, including all requested settings. Use the attached images as references for the edit when present. Return the generated image, then stop.\n\n${JSON.stringify(
      {
        description: input.prompt,
        ...(input.negativePrompt ? { avoid: input.negativePrompt } : {}),
        ...(input.width !== undefined ? { widthPx: input.width } : {}),
        ...(input.height !== undefined ? { heightPx: input.height } : {}),
        ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
        ...(input.quality ? { quality: input.quality } : {}),
        ...(input.strength !== undefined
          ? {
              editStrength: `${Math.round(input.strength * 100)}% change; preserve the rest of the reference`,
            }
          : {}),
      },
    )}`,
    notes,
  };
}

export function decodeCodexImage(item: RpcRecord) {
  if (record(item.failure).type === 'usageLimitExceeded')
    throw new Error(
      'Codex image generation reached your account usage limit. Check Codex before trying again.',
    );
  if (item.status !== 'completed' || item.failure)
    throw new Error('Codex image generation did not complete successfully.');
  if (typeof item.result !== 'string' || !item.result || item.result.length > 90_000_000)
    throw new Error(
      'Codex did not return image bytes. Update Codex CLI and check image-generation access.',
    );
  // Accept only bytes in the native image event, never a filename or prose from the model.
  const png = Buffer.from(item.result, 'base64');
  const meta = readImageMeta(png);
  if (
    !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    !meta ||
    meta.width < 1 ||
    meta.height < 1
  )
    throw new Error('Codex returned invalid PNG image data.');
  return { png, width: meta.width, height: meta.height };
}

export function codexImageSizeNotes(
  input: ImageGenerationInput,
  width: number,
  height: number,
): string[] {
  if (
    (input.width !== undefined && input.width !== width) ||
    (input.height !== undefined && input.height !== height)
  )
    return [`Codex returned ${width}×${height}; the requested pixel dimensions were not matched.`];
  if (input.aspectRatio && Math.abs(width / height - aspectRatioValue(input.aspectRatio)) > 0.01)
    return [
      `Codex returned ${width}×${height}, which differs from the requested ${input.aspectRatio} aspect ratio.`,
    ];
  return [];
}
