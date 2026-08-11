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
});
