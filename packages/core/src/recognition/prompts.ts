import type { RecognitionMode } from '../schemas/recognition.js';

/**
 * Per-mode prompting for the vision model. Kept in one table so tuning these
 * is a data edit, not a code change — the same reasoning behind the
 * model-profile behaviors. Shared with the phone, whose describers (Gemini
 * Nano, Foundation Models, a small model on llama.cpp) read the same words.
 */

export interface ModePrompt {
  system: string;
  user: string;
  maxTokens: number;
}

const TERSE =
  'Answer with the content only. No preamble, no "This image shows", no offers to help further.';

export const MODE_PROMPTS: Record<RecognitionMode, ModePrompt> = {
  describe: {
    system: `You describe images accurately and concisely for someone who cannot see them. ${TERSE}`,
    user: 'Describe this image in two or three sentences. Name the subject, the setting, and anything a reader would need in order to reason about it. If there is legible text, quote the important parts.',
    maxTokens: 400,
  },
  ocr: {
    system: `You transcribe text from images exactly as written. ${TERSE}`,
    user: 'Transcribe all legible text in this image. Preserve reading order, line breaks, and table structure. Use markdown for tables. Do not summarize, correct, or translate. If a passage is unreadable, write [illegible].',
    maxTokens: 1600,
  },
  ui: {
    system: `You transcribe application screenshots into structured markdown so another program can reason about them. ${TERSE}`,
    user: [
      'Transcribe this screenshot. Use exactly these sections, omitting any that do not apply:',
      '',
      '**Window**: the application and window/page title.',
      '**Layout**: the main regions, in reading order.',
      '**Text**: every visible string, verbatim, each tagged with its role — button, label, tab, menu item, field, heading, error, or body.',
      '**State**: anything selected, focused, checked, disabled, loading, or showing an error.',
      '',
      'Quote strings exactly, including punctuation and capitalization. Do not describe visual style.',
    ].join('\n'),
    maxTokens: 1600,
  },
  extract: {
    system:
      'You extract structured data from images. You output only JSON matching the requested schema, with no commentary or code fences.',
    user: 'Extract the requested fields from this image. Use null for anything not present in the image. Never invent a value.',
    maxTokens: 1200,
  },
};
