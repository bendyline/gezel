import { describe, expect, it } from 'vitest';
import { proseChoiceQuestion } from './prose-choice-question.js';

describe('proseChoiceQuestion', () => {
  // The Linux CLI reply that ended on a menu (gemma4-e2b, 2026-11-02).
  it('reads a question above numbered options as a card', () => {
    expect(
      proseChoiceQuestion(
        [
          "I can't directly convert JSON files to DOCX format.",
          '',
          'However, I can build a script that reads the JSON data.',
          '',
          'Which of these would you prefer?',
          '',
          '1.  **Generate Markdown files:** I can write a script to convert each JSON file.',
          '2.  **Generate a single summary document:** I can read all the relevant files.',
          '3.  **Search for an existing conversion tool:** I can search the scripts.',
        ].join('\n'),
      ),
    ).toEqual({
      prompt: 'Which of these would you prefer?',
      choices: [
        'Generate Markdown files',
        'Generate a single summary document',
        'Search for an existing conversion tool',
      ],
    });
  });

  it('reads options followed by the question', () => {
    expect(
      proseChoiceQuestion(
        'I see two ways:\n\n- Rewrite the parser\n- Patch the caller\n\nWhich one should I take?',
      ),
    ).toEqual({
      prompt: 'Which one should I take?',
      choices: ['Rewrite the parser', 'Patch the caller'],
    });
  });

  it('keeps only the question sentence and shortens long options', () => {
    const long = `Use ${'a very long description '.repeat(8)}`;
    const result = proseChoiceQuestion(
      `Both work. Which option do you prefer?\n1. ${long}\n2. Keep it short`,
    );
    expect(result?.prompt).toBe('Which option do you prefer?');
    expect(result?.choices[0]?.length).toBeLessThanOrEqual(101);
    expect(result?.choices[0]?.endsWith('…')).toBe(true);
  });

  it.each([
    [
      'a summary of finished work',
      'Done:\n\n1. Fixed the parser\n2. Added a test\n\nAnything else?',
    ],
    ['a closing question that is not about the list', 'Changes:\n- a\n- b\n\nShould I commit?'],
    ['a single option', 'Which of these would you prefer?\n\n1. Only one'],
    ['options that are not the end of the reply', 'Which do you prefer?\n1. A\n2. B\n\nThanks!'],
    ['an open code block', 'Which file?\n```\n1. a\n2. b'],
    ['repeated options', 'Which one?\n1. Same\n2. Same'],
  ])('leaves %s alone', (_label, content) => {
    expect(proseChoiceQuestion(content)).toBeNull();
  });
});
