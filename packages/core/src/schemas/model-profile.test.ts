import { describe, expect, it } from 'vitest';
import { ModelFamilySchema, ModelStyleSchema } from './model-profile.js';

describe('model profile schemas', () => {
  it('accepts Muse as a distinct model family', () => {
    expect(ModelFamilySchema.parse('muse')).toBe('muse');
    expect(
      ModelStyleSchema.parse({
        family: 'muse',
        reasoningFormat: 'channel',
        toolCallFormat: 'function-call',
      }),
    ).toEqual({
      family: 'muse',
      reasoningFormat: 'channel',
      toolCallFormat: 'function-call',
    });
  });

  it('accepts Granite as a distinct model family', () => {
    expect(ModelFamilySchema.parse('granite')).toBe('granite');
    expect(
      ModelStyleSchema.parse({
        family: 'granite',
        reasoningFormat: 'think',
        toolCallFormat: 'function-call',
      }),
    ).toEqual({
      family: 'granite',
      reasoningFormat: 'think',
      toolCallFormat: 'function-call',
    });
  });
});
