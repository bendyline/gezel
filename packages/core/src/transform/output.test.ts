import { describe, expect, it } from 'vitest';
import { cleanTransformOutput, oneShotSystemMessage } from './output.js';

describe('authoritative transform output', () => {
  it('removes prefixed and explicit reasoning plus a wrapping Markdown fence', () => {
    expect(cleanTransformOutput('prefilled planning</think>\n```md\nEdited text.\n```')).toBe(
      'Edited text.',
    );
    expect(cleanTransformOutput('[THINK]plan[/THINK]<eos>Edited text.')).toBe('Edited text.');
    expect(cleanTransformOutput('<|channel|>analysis<|message|>plan<|end|>Edited text.')).toBe(
      'Edited text.',
    );
  });
  it.each([
    '<think>unfinished',
    '<reasoning>unfinished',
    '[THINK]unfinished',
    '<think>closed</think>Text.<think>unfinished',
  ])('rejects unfinished reasoning: %s', (text) => {
    expect(() => cleanTransformOutput(text)).toThrow('unfinished reasoning');
  });
  it('retains the exact desktop one-shot system wording with and without a persona', () => {
    const base =
      'You respond to a single self-contained prompt. Follow the output format requested by the user exactly.';
    expect(oneShotSystemMessage()).toBe(base);
    expect(oneShotSystemMessage('The chosen Klerk.')).toBe(`The chosen Klerk.\n\n---\n\n${base}`);
  });
});
