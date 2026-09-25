import { stripReasoningTags } from './reasoning.js';

export function stripTransformFences(text: string): string {
  const full = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/);
  if (full && full[1] !== undefined) return full[1];
  return text;
}

export function cleanTransformOutput(text: string): string {
  const lower = text.toLowerCase();
  for (const [open, close] of [
    ['<think>', '</think>'],
    ['<reasoning>', '</reasoning>'],
    ['[think]', '[/think]'],
  ] as const) {
    if (lower.lastIndexOf(open) > lower.lastIndexOf(close))
      throw new Error('The model returned unfinished reasoning. Try the text transform again.');
  }
  return stripTransformFences(stripReasoningTags(text)).trim();
}

/** Shared with desktop one-shot completions; keep persona prose verbatim. */
export function oneShotSystemMessage(personaAbout?: string): string {
  const baseSystem =
    'You respond to a single self-contained prompt. Follow the output format requested by the user exactly.';
  return personaAbout ? `${personaAbout}\n\n---\n\n${baseSystem}` : baseSystem;
}
