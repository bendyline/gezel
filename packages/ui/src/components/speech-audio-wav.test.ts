import { describe, expect, it } from 'vitest';
import { encodeMonoPcm16Wav } from './speech-audio-wav.js';

describe('encodeMonoPcm16Wav', () => {
  it('writes a mono PCM WAV that averages and clamps browser audio channels', () => {
    const bytes = encodeMonoPcm16Wav(
      [new Float32Array([1, -1, 0.5]), new Float32Array([1, -1, -0.5])],
      48_000,
    );
    const view = new DataView(bytes.buffer);

    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe('WAVE');
    expect(new TextDecoder().decode(bytes.subarray(36, 40))).toBe('data');
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(6);
    expect(view.getInt16(44, true)).toBe(0x7fff);
    expect(view.getInt16(46, true)).toBe(-0x8000);
    expect(view.getInt16(48, true)).toBe(0);
  });

  it('rejects empty audio instead of uploading an invalid take', () => {
    expect(() => encodeMonoPcm16Wav([], 48_000)).toThrow(/empty/i);
  });
});
