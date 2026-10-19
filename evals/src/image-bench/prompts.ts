/**
 * The image bench's fixed prompts. Each one probes a failure that shows up
 * in real use: a model that cannot draw hands, cannot count, cannot spell,
 * or ignores a style. Prompts are plain English sentences, the shape
 * `generate_image` receives from a chat model, never a model-specific tag
 * dialect; how much each model gains from its own dialect is a separate
 * question (see IMAGE-BENCH.md).
 *
 * Changing a prompt's text invalidates every recorded score for it. Add a
 * new id instead.
 */

export type ImageBenchCategory =
  | 'photo'
  | 'people'
  | 'scene'
  | 'composition'
  | 'text'
  | 'design'
  | 'illustration';

export interface ImageBenchPrompt {
  id: string;
  category: ImageBenchCategory;
  prompt: string;
  /** What a reviewer (a person or a vision model) checks the image for. */
  expect: string;
  /** Words the image must show legibly, for text-rendering prompts. */
  text?: readonly string[];
}

export const IMAGE_BENCH_PROMPTS: readonly ImageBenchPrompt[] = [
  {
    id: 'apple',
    category: 'photo',
    prompt: 'a red apple on a wooden table, studio photo, soft light',
    expect: 'One red apple on a wooden surface, photographic, in focus.',
  },
  {
    id: 'portrait',
    category: 'people',
    prompt: 'close-up portrait photo of an elderly woman smiling, natural window light',
    expect: 'One face with two symmetric eyes, natural skin and teeth, no melted features.',
  },
  {
    id: 'hands',
    category: 'people',
    prompt: "a person's hands holding a white ceramic coffee mug, top-down photo",
    expect: 'Two hands with five fingers each wrapped around one mug.',
  },
  {
    id: 'lake',
    category: 'scene',
    prompt: 'a mountain lake at sunrise with pine trees and morning mist, wide landscape photo',
    expect: 'Lake, mountains, pine trees and mist; a coherent horizon.',
  },
  {
    id: 'cubes',
    category: 'composition',
    prompt: 'three blue cubes to the left of a yellow sphere on a white floor, simple 3D render',
    expect: 'Exactly three blue cubes and one yellow sphere, the cubes on the left.',
  },
  {
    id: 'sign',
    category: 'text',
    prompt: 'a wooden shop sign that says "OPEN" hanging on a brick wall, photo',
    expect: 'A wooden sign whose only word is OPEN, spelled correctly.',
    text: ['OPEN'],
  },
  {
    id: 'poster',
    category: 'text',
    prompt:
      'a minimalist event poster with the title "GARDEN PARTY" and the date "JUNE 14", flat design',
    expect: 'A poster showing GARDEN PARTY and JUNE 14, both spelled correctly.',
    text: ['GARDEN PARTY', 'JUNE 14'],
  },
  {
    id: 'watercolor',
    category: 'illustration',
    prompt: 'a watercolor illustration of a fox reading a book under a tree',
    expect: 'Watercolor style; a fox holding or reading a book; a tree.',
  },
  {
    id: 'anime',
    category: 'illustration',
    prompt:
      'an anime-style illustration of a girl with silver hair in a school uniform under cherry blossoms',
    expect: 'Anime style; silver hair; school uniform; pink blossoms.',
  },
  {
    id: 'logo',
    category: 'design',
    prompt: 'a flat vector logo of a lighthouse, simple shapes, two colors, white background',
    expect: 'A simple flat lighthouse mark on white, few colors, no photographic texture.',
  },
  {
    id: 'ramen',
    category: 'photo',
    prompt: 'a bowl of ramen with a soft-boiled egg, overhead food photography',
    expect: 'One bowl of ramen from above with a halved soft-boiled egg.',
  },
  {
    id: 'weather-app',
    category: 'design',
    prompt: 'a clean mobile app screen for a weather app showing "72°F" and a sun icon',
    expect: 'A phone-screen layout with a sun icon and the reading 72°F.',
    text: ['72°F'],
  },
];

/** Named prompt sets. `smoke` is four prompts for a quick per-model check. */
export const IMAGE_BENCH_SUITES: Readonly<Record<string, readonly string[]>> = {
  smoke: ['apple', 'portrait', 'cubes', 'sign'],
  sanity: IMAGE_BENCH_PROMPTS.map((p) => p.id),
};

export function resolveImageBenchPrompts(
  suite: string,
  ids?: readonly string[],
): ImageBenchPrompt[] {
  const wanted = ids && ids.length > 0 ? ids : IMAGE_BENCH_SUITES[suite];
  if (!wanted) {
    throw new Error(
      `unknown image-bench suite "${suite}" (known: ${Object.keys(IMAGE_BENCH_SUITES).join(', ')})`,
    );
  }
  return wanted.map((id) => {
    const prompt = IMAGE_BENCH_PROMPTS.find((p) => p.id === id);
    if (!prompt) throw new Error(`unknown image-bench prompt "${id}"`);
    return prompt;
  });
}
