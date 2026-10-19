/**
 * What a model that writes image prompts needs to know about the image model
 * that will read them. Image models read prompts differently: Flux, Krea and
 * MOSS want plain sentences, Animagine wants booru tags, only some can letter
 * a sign, and a model run at CFG 1 ignores a negative prompt entirely (image
 * bench, 2026-10-19). One sentence, written here, so the `generate_image`
 * result and the composer's image shaping say the same thing.
 *
 * Pure and browser-safe.
 */
import type { ImagePromptStyle } from './schemas/catalog.js';

export interface ImagePromptTraits {
  /** Display name of the image model. */
  name: string;
  promptStyle?: ImagePromptStyle | undefined;
  rendersText?: boolean | undefined;
  /** Whether the engine runs the model with guidance that reads a negative prompt. */
  negativePromptHonored?: boolean | undefined;
}

/** One sentence naming how this model reads a prompt; undefined when nothing is known. */
export function imagePromptGuide(traits: ImagePromptTraits): string | undefined {
  const parts: string[] = [];
  if (traits.promptStyle === 'tags') {
    // The example names no person: "1girl, solo" here taught a small model
    // to add a girl to a watercolor fox (2026-10-19).
    parts.push(
      'reads comma-separated booru tags (red apple, wooden table, soft light), not sentences',
    );
  } else if (traits.promptStyle === 'sentences') {
    parts.push('reads plain descriptive sentences');
  }
  if (traits.rendersText === true) {
    parts.push('can letter short text: put the exact words in quotes');
  } else if (traits.rendersText === false) {
    parts.push('cannot letter text reliably, so leave words out of the image');
  }
  if (traits.negativePromptHonored === false) {
    parts.push('ignores negative prompts, so leave unwanted things out of the prompt instead');
  }
  if (parts.length === 0) return undefined;
  return `${traits.name} ${parts.join('; ')}.`;
}
