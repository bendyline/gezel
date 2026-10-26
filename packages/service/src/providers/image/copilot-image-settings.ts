import { createHash } from 'node:crypto';
import { aspectRatioValue } from '@bendyline/gezel';
import { readImageMeta } from '@bendyline/gezel-inference/internal/utils/image-meta';
import { pickSize } from './openai-image.js';
import type { ImageGenerationInput } from './types.js';

/** Copilot CLI 1.0.103's native image tool accepts these settings, independently of chat models. */
export function copilotImageSettings(input: ImageGenerationInput) {
  const notes: string[] = [];
  const ratio = input.aspectRatio ? aspectRatioValue(input.aspectRatio) : 1;
  const wantsSize =
    input.width !== undefined || input.height !== undefined || input.aspectRatio !== undefined;
  const width =
    input.width ??
    (input.height ? Math.round(input.height * ratio) : Math.round(1024 * Math.sqrt(ratio)));
  const height =
    input.height ??
    (input.width ? Math.round(input.width / ratio) : Math.round(1024 / Math.sqrt(ratio)));
  const choice = wantsSize ? pickSize(width, height) : {};
  if (choice.snappedFrom) {
    notes.push(
      `Copilot supports 1024×1024, 1536×1024, and 1024×1536. Requested ${input.width || input.height ? choice.snappedFrom : input.aspectRatio}; used ${choice.size}.`,
    );
  }
  const prompt = input.negativePrompt?.trim()
    ? `${input.prompt}\n\nAvoid the following in the image: ${input.negativePrompt.trim()}`
    : input.prompt;
  if (!prompt.trim() || prompt.length > 32_000)
    throw new Error('Copilot image prompts must contain 1–32,000 characters.');
  if (input.negativePrompt?.trim())
    notes.push(
      'The negative prompt was included as instructions; Copilot has no separate negative-prompt control.',
    );
  if (input.seed !== undefined)
    notes.push('Copilot does not support a reproducible seed; the requested seed was not applied.');
  if (input.steps !== undefined)
    notes.push('Copilot manages sampling steps; the requested step count was not applied.');
  if (input.strength !== undefined)
    notes.push(
      'Copilot does not support an edit-strength slider; describe how much to change in the prompt.',
    );
  return {
    arguments: {
      prompt,
      ...(choice.size ? { size: choice.size } : {}),
      ...(input.quality
        ? { quality: { draft: 'low', standard: 'medium', high: 'high' }[input.quality] }
        : {}),
    },
    notes,
  };
}

const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Only accept a native image result with matching bytes, never a filename or prose claim. */
export function decodeCopilotImage(result: unknown) {
  const res = record(result);
  if (res?.resultType !== 'success') {
    throw new Error(
      `Copilot image generation failed: ${typeof res?.error === 'string' ? res.error : typeof res?.textResultForLlm === 'string' ? res.textResultForLlm : 'no image was returned'}`,
    );
  }
  const images = record(record(res.structuredContent)?.imageGeneration)?.images;
  if (!Array.isArray(images) || images.length !== 1 || !Array.isArray(res.contents)) {
    throw new Error('Copilot did not return exactly one generated image.');
  }
  const image = record(images[0]);
  const content =
    image && Number.isInteger(image.contentIndex)
      ? record(res.contents[image.contentIndex as number])
      : undefined;
  if (
    image?.mimeType !== 'image/png' ||
    content?.type !== 'image' ||
    content.mimeType !== 'image/png' ||
    typeof content.data !== 'string' ||
    content.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
  ) {
    throw new Error('Copilot returned an unsupported or oversized image.');
  }
  const png = Buffer.from(content.data, 'base64');
  if (
    !png.subarray(0, 8).equals(PNG_SIGNATURE) ||
    `sha256:${createHash('sha256').update(png).digest('hex')}` !== image.imageId
  ) {
    throw new Error('Copilot returned invalid image data.');
  }
  const meta = readImageMeta(png);
  if (!meta || meta.width < 1 || meta.height < 1)
    throw new Error('Copilot returned invalid image dimensions.');
  return { png, width: meta.width, height: meta.height };
}
