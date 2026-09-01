import { describe, expect, it } from 'vitest';
import { AUDIO_TRANSCRIBE_PROMPT_MAX_CHARS, AudioTranscribeRequestSchema } from './audio.js';

describe('AudioTranscribeRequestSchema', () => {
  const audio = { data: 'UklGRg==', mimeType: 'audio/wav' };

  it('accepts bounded prior transcript context', () => {
    expect(
      AudioTranscribeRequestSchema.parse({ audio, prompt: 'One, two, three, four.' }).prompt,
    ).toBe('One, two, three, four.');
  });

  it('rejects recognition context beyond the wire limit', () => {
    expect(() =>
      AudioTranscribeRequestSchema.parse({
        audio,
        prompt: 'x'.repeat(AUDIO_TRANSCRIBE_PROMPT_MAX_CHARS + 1),
      }),
    ).toThrow();
  });
});
