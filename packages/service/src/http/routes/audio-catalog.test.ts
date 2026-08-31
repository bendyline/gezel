import { describe, expect, it } from 'vitest';
import { isKokoroRuntimeAvailable } from '../../providers/audio/kokoro.js';
import { buildAudioCatalog, speechToTextErrorCode } from './audio.js';

describe('audio catalog runtime capabilities', () => {
  it('advertises Kokoro only when its optional runtime is installed', () => {
    expect(buildAudioCatalog({ kokoroRuntimeAvailable: false }).tts).toEqual([]);
    expect(buildAudioCatalog({ kokoroRuntimeAvailable: true }).tts).toEqual([
      expect.objectContaining({ id: 'kokoro-82m-v1.0', kind: 'tts' }),
    ]);
  });

  it('checks both optional packages without importing either one', () => {
    const resolved: string[] = [];
    const resolveInstalled = (specifier: string) => {
      resolved.push(specifier);
      return 'installed';
    };
    expect(isKokoroRuntimeAvailable(resolveInstalled)).toBe(true);
    expect(resolved).toEqual(['kokoro-js', '@huggingface/transformers']);

    expect(
      isKokoroRuntimeAvailable((specifier) => {
        if (specifier === '@huggingface/transformers') throw new Error('missing');
        return 'installed';
      }),
    ).toBe(false);
  });

  it('maps provider failures to stable, non-sensitive narration error codes', () => {
    expect(
      speechToTextErrorCode(
        new Error(
          'No STT model is available locally. Download one from Settings → Audio before transcribing.',
        ),
      ),
    ).toBe('speech_to_text_not_ready');
    expect(speechToTextErrorCode(new Error('C:\\private\\engine detail'))).toBe(
      'speech_to_text_failed',
    );
  });
});
