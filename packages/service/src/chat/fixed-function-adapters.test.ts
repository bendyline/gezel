import { describe, expect, it, vi } from 'vitest';
import {
  buildVideoPromptExpansionInput,
  cleanGenerativePrompt,
  expandVideoPrompt,
  firstSentence,
  formatFixedFunctionResult,
  sanitizeExpandedVideoPrompt,
  stripGezelMentions,
} from './fixed-function-adapters.js';

describe('stripGezelMentions', () => {
  it('removes a leading mention with project suffix', () => {
    const out = stripGezelMentions(
      '@[Glen re: Car Logo Design](gezel:glen?project=car-logo-design) car full of tomatoes',
    );
    expect(out).toBe('car full of tomatoes');
  });

  it('removes a bare mention with no project suffix', () => {
    expect(stripGezelMentions('@[Glen](gezel:glen) draw a horse')).toBe('draw a horse');
  });

  it('handles the backslash-escaped colon variant', () => {
    expect(stripGezelMentions('@[Glen](gezel\\:glen) draw a horse')).toBe('draw a horse');
  });

  it('removes multiple mentions and collapses whitespace', () => {
    const out = stripGezelMentions('@[A](gezel:a) and @[B](gezel:b) sketch a house');
    expect(out).toBe('and sketch a house');
  });

  it('preserves text without mentions', () => {
    expect(stripGezelMentions('two horses jumping a cow')).toBe('two horses jumping a cow');
  });

  it('returns empty input as-is', () => {
    expect(stripGezelMentions('')).toBe('');
  });

  it('does not strip @-signs that are not gezel mentions', () => {
    expect(stripGezelMentions('email me @ user@example.com please')).toBe(
      'email me @ user@example.com please',
    );
  });
});

describe('firstSentence', () => {
  it('cuts at the first ". " sentence boundary', () => {
    const out = firstSentence(
      'Generated 512x512 image with sdxl-base. The user already sees this image inline.',
    );
    expect(out).toBe('Generated 512x512 image with sdxl-base.');
  });

  it('cuts at the first newline when it precedes the first ". "', () => {
    const out = firstSentence('First line\nSecond line. Third sentence.');
    expect(out).toBe('First line');
  });

  it('returns a single short sentence unchanged', () => {
    expect(firstSentence('All done.')).toBe('All done.');
  });

  it('returns empty input as empty', () => {
    expect(firstSentence('')).toBe('');
  });

  it('trims surrounding whitespace', () => {
    expect(firstSentence('  Hello.  ')).toBe('Hello.');
  });
});

describe('formatFixedFunctionResult — generate_image adapter', () => {
  it('extracts dimensions + model and drops the LLM-instruction tail', () => {
    const raw =
      'Generated 512×512 image with sdxl-base-1.0 (seed 451360623, 20 steps, 79589ms) to ' +
      'artifacts/generated/image-2026-05-04T01-38-03-944Z-451360623.png. The user already ' +
      'sees this image inline below the tool call — DO NOT embed it again as Markdown ' +
      '(e.g. ![alt](artifacts/generated/...png)); just refer to it by name in your reply ' +
      'when needed. To iterate on it, pass { inputImages: [{ artifactPath: "..." }] }.';
    const out = formatFixedFunctionResult('generate_image', raw, { prompt: 'a car' });
    expect(out).toBe('Generated 512×512 image with sdxl-base-1.0.');
  });

  it('handles ascii x dimensions', () => {
    const raw = 'Generated 1024x1024 image with sd-3.5 (seed 1, 20 steps).';
    expect(formatFixedFunctionResult('generate_image', raw, {})).toBe(
      'Generated 1024x1024 image with sd-3.5.',
    );
  });

  it('preserves the exact workspace img tag when the tool returns one', () => {
    const raw =
      'Generated 512×512 image with sdxl-lightning-4step (seed 361783959, 4 steps, 500000ms). ' +
      'To display this image in HTML, copy this exact tag verbatim — do not add any prefix, do not change the filename:\n' +
      '`<img src="assets/generated/image-361783959.png">`';
    expect(formatFixedFunctionResult('generate_image', raw, {})).toBe(
      'Generated 512×512 image with sdxl-lightning-4step. Use `<img src="assets/generated/image-361783959.png">` in workspace HTML.',
    );
  });

  it('falls through to first-sentence on pattern mismatch', () => {
    const raw = 'Image rendered. Some other detail line.';
    expect(formatFixedFunctionResult('generate_image', raw, {})).toBe('Image rendered.');
  });

  it('surfaces an img2img skip so the user knows no edit happened', () => {
    const raw =
      'Generated 512×512 image with flux-2-klein-4b-q4 (seed 42, 4 steps, 800ms). ' +
      'NOTE: the source image was not used — model flux-2-klein-4b-q4 does not support image ' +
      'editing (img2img) on the bundled engine; the image was generated from the prompt alone. ' +
      'The user already sees this image inline below the tool call.';
    expect(formatFixedFunctionResult('generate_image', raw, {})).toBe(
      'Generated 512×512 image with flux-2-klein-4b-q4. (This model cannot edit an existing image — regenerated from the revised prompt instead.)',
    );
  });
});

describe('cleanGenerativePrompt', () => {
  it('strips conversational framing from a request', () => {
    expect(cleanGenerativePrompt('Can you generate a smiling cat?')).toBe('a smiling cat');
    expect(cleanGenerativePrompt('create a video of a mustang car')).toBe('a mustang car');
    expect(cleanGenerativePrompt('please make me an image of a sunset')).toBe('a sunset');
    expect(cleanGenerativePrompt('show me a video of waves crashing')).toBe('waves crashing');
  });

  it('leaves a clean prompt untouched', () => {
    expect(cleanGenerativePrompt('mustang car')).toBe('mustang car');
    expect(cleanGenerativePrompt('a smiling cat')).toBe('a smiling cat');
    expect(cleanGenerativePrompt('an astronaut riding a horse, cinematic')).toBe(
      'an astronaut riding a horse, cinematic',
    );
  });

  it('does not strip a bare article that belongs to the subject', () => {
    // "a video of a cat" → peel "a video of" → "a cat" (keep the article).
    expect(cleanGenerativePrompt('a video of a cat')).toBe('a cat');
  });

  it('falls back to the original when stripping would empty it', () => {
    expect(cleanGenerativePrompt('generate')).toBe('generate');
    expect(cleanGenerativePrompt('please make')).toBe('please make');
  });

  it('peels the newer chattier video framings', () => {
    expect(cleanGenerativePrompt('how about a video of a dog skating')).toBe('a dog skating');
    expect(cleanGenerativePrompt("i'd love a short clip of rain on a window")).toBe(
      'rain on a window',
    );
    expect(cleanGenerativePrompt('a video where a robot waters plants')).toBe(
      'a robot waters plants',
    );
  });

  it('strips a trailing sign-off please but keeps internal words', () => {
    expect(cleanGenerativePrompt('a smiling cat, please.')).toBe('a smiling cat');
    expect(cleanGenerativePrompt('waves crashing pls')).toBe('waves crashing');
    // "please" mid-prompt is left alone (only a trailing sign-off is peeled).
    expect(cleanGenerativePrompt('a sign that says please stop')).toBe(
      'a sign that says please stop',
    );
  });
});

describe('sanitizeExpandedVideoPrompt', () => {
  it('strips leaked <think> reasoning and keeps the description', () => {
    const raw =
      '<think>The user wants a cat. Let me describe it.</think>A ginger cat sits on a sunny windowsill, slowly blinking.';
    expect(sanitizeExpandedVideoPrompt(raw)).toBe(
      'A ginger cat sits on a sunny windowsill, slowly blinking.',
    );
  });

  it('drops chatty preambles, labels, fences and quotes; collapses newlines', () => {
    expect(
      sanitizeExpandedVideoPrompt('Sure! Here is the shot:\n"A neon city street at night."'),
    ).toBe('A neon city street at night.');
    expect(sanitizeExpandedVideoPrompt('Prompt: A lone tree on a\nwindswept hill.')).toBe(
      'A lone tree on a windswept hill.',
    );
    expect(sanitizeExpandedVideoPrompt('```\nA red balloon drifts upward.\n```')).toBe(
      'A red balloon drifts upward.',
    );
  });

  it('returns empty for nothing usable', () => {
    expect(sanitizeExpandedVideoPrompt('')).toBe('');
    expect(sanitizeExpandedVideoPrompt('<think>just thinking</think>')).toBe('');
  });
});

describe('expandVideoPrompt', () => {
  it('expands a short prompt via the model and returns the sanitized result', async () => {
    const complete = vi
      .fn()
      .mockResolvedValue(
        'A fluffy orange cat sits on a windowsill in warm afternoon light, smiling softly as its whiskers twitch; the camera slowly pushes in.',
      );
    const out = await expandVideoPrompt('smiling cat', complete);
    expect(complete).toHaveBeenCalledOnce();
    // The model received the LTX instruction wrapper + the idea.
    expect(complete.mock.calls[0]![0]).toContain('Idea: smiling cat');
    expect(out).toContain('orange cat');
    expect(out.length).toBeGreaterThan('smiling cat'.length);
  });

  it('passes a long, deliberate prompt through with NO model call', async () => {
    const complete = vi.fn();
    const detailed =
      'A lone astronaut drifts past a cracked space-station window at golden hour, Earth glowing below, as the camera slowly orbits in a wide cinematic shot';
    expect(await expandVideoPrompt(detailed, complete)).toBe(detailed);
    expect(complete).not.toHaveBeenCalled();
  });

  it('falls back to the cleaned prompt when the model errors', async () => {
    const complete = vi.fn().mockRejectedValue(new Error('timeout'));
    expect(await expandVideoPrompt('smiling cat', complete)).toBe('smiling cat');
  });

  it('falls back when the model returns nothing usable or no real expansion', async () => {
    expect(
      await expandVideoPrompt('smiling cat', vi.fn().mockResolvedValue('<think>hm</think>')),
    ).toBe('smiling cat');
    // Too short to be a real shot description.
    expect(await expandVideoPrompt('smiling cat', vi.fn().mockResolvedValue('a cat'))).toBe(
      'smiling cat',
    );
  });

  it('builds an instruction that asks for a single descriptive shot', () => {
    const input = buildVideoPromptExpansionInput('a dog surfing');
    expect(input).toContain('text-to-video');
    expect(input).toMatch(/Idea: a dog surfing$/);
  });
});

describe('formatFixedFunctionResult — generate_video adapter', () => {
  it('extracts dimensions + model and drops the LLM-instruction tail', () => {
    const raw =
      'Generated a 1280×704 video with wan2.2-ti2v-5b (121 frames @ 24fps, seed 42, 50 steps, ' +
      '600000ms). The user sees a poster frame inline below the tool call. The clip is at ' +
      'artifacts/generated/video-...mp4 — read its bytes with read_artifact if needed.';
    const out = formatFixedFunctionResult('generate_video', raw, { prompt: 'a boat' });
    expect(out).toBe('Generated 1280×704 video with wan2.2-ti2v-5b.');
  });

  it('preserves the exact workspace video tag when the tool returns one', () => {
    const raw =
      'Generated a 704×480 video with ltx-video-0.9.7 (97 frames @ 24fps). ' +
      'To display this video in HTML, copy this exact tag verbatim:\n' +
      '`<video src="assets/generated/video-12345.mp4" controls></video>`';
    expect(formatFixedFunctionResult('generate_video', raw, {})).toBe(
      'Generated 704×480 video with ltx-video-0.9.7. Use `<video src="assets/generated/video-12345.mp4" controls></video>` in workspace HTML.',
    );
  });
});

describe('formatFixedFunctionResult — fallback', () => {
  it('uses firstSentence for tools without a specific adapter', () => {
    const raw = 'Searched the web. Found 12 results matching your query.';
    expect(formatFixedFunctionResult('web_search', raw, { query: 'foo' })).toBe(
      'Searched the web.',
    );
  });
});
