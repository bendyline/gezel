import { describe, expect, it } from 'vitest';
import { composeQuestionPrompt, resolveQuestionTaskRef } from './question-prompt.js';

describe('composeQuestionPrompt', () => {
  it('preserves a short question heading and its explanatory prompt', () => {
    expect(
      composeQuestionPrompt({
        question: 'Gate regex bug blocking step advance',
        prompt: 'The completion gate cannot match the scope note, so the task cannot continue.',
      }),
    ).toBe(
      'Gate regex bug blocking step advance\n\nThe completion gate cannot match the scope note, so the task cannot continue.',
    );
  });

  it('accepts aliases, trims them, and removes exact duplicates', () => {
    expect(
      composeQuestionPrompt({
        prompt: '  Which option should I use?  ',
        description: 'Which option should I use?',
      }),
    ).toBe('Which option should I use?');
  });

  it('returns an empty string when every field is blank', () => {
    expect(composeQuestionPrompt({ question: ' ', prompt: '\n' })).toBe('');
  });
});

describe('resolveQuestionTaskRef', () => {
  it('inherits the current session task when the model omits taskRef', () => {
    expect(resolveQuestionTaskRef(undefined, 'default/12')).toBe('default/12');
  });

  it('keeps an explicit taskRef', () => {
    expect(resolveQuestionTaskRef('default/13', 'default/12')).toBe('default/13');
  });
});
