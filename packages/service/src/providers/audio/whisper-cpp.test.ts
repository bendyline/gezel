import { describe, expect, it } from 'vitest';
import { inlineAudioFilename } from './whisper-cpp.js';

describe('inlineAudioFilename', () => {
  it('removes MediaRecorder codec parameters from the upload filename', () => {
    expect(inlineAudioFilename('audio/webm;codecs=opus')).toBe('audio.webm');
    expect(inlineAudioFilename('audio/mp4;codecs=mp4a.40.2')).toBe('audio.mp4');
  });

  it('falls back safely for a malformed MIME type', () => {
    expect(inlineAudioFilename('not-a-mime')).toBe('audio.wav');
  });
});
