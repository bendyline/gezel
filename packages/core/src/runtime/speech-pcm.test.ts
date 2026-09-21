import { describe, expect, it } from 'vitest';
import { speechPcm16 } from './speech-pcm.js';

function wav(rate = 48000, channels = 1, seconds = 0.1) {
  const frames = Math.ceil(rate * seconds);
  const bytes = new Uint8Array(44 + frames * channels * 2);
  const view = new DataView(bytes.buffer);
  for (const [at, value] of [
    [0, 'RIFF'],
    [8, 'WAVE'],
    [12, 'fmt '],
    [36, 'data'],
  ] as const)
    bytes.set(new TextEncoder().encode(value), at);
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, bytes.length - 44, true);
  for (let i = 44; i < bytes.length; i += 2) view.setInt16(i, 12000, true);
  return bytes;
}
describe('portable speech recording normalization', () => {
  it.each([8000, 16000, 24000, 44100, 48000, 96000])(
    'normalizes %i Hz without changing duration or a constant signal',
    (rate) => {
      const output = speechPcm16(wav(rate));
      expect(output.length).toBe(3200);
      const view = new DataView(output.buffer);
      for (let i = 0; i < output.length; i += 2) expect(view.getInt16(i, true)).toBe(12000);
    },
  );
  it('mixes stereo and handles a byte array view', () => {
    const input = wav(16000, 2);
    const view = new DataView(input.buffer);
    for (let i = 46; i < input.length; i += 4) view.setInt16(i, -12000, true);
    const container = new Uint8Array(input.length + 16);
    container.set(input, 8);
    expect(
      speechPcm16(container.subarray(8, 8 + input.length)).every((sample) => sample === 0),
    ).toBe(true);
  });
  it('rejects corrupt lengths, unsupported formats, and unbounded recordings', () => {
    expect(() => speechPcm16(wav().subarray(0, 100))).toThrow();
    expect(() => speechPcm16(wav(48000, 3))).toThrow();
    expect(() => speechPcm16(wav(16000, 1, 121))).toThrow(/two minutes/);
    const encoded = wav();
    new DataView(encoded.buffer).setUint16(20, 3, true);
    expect(() => speechPcm16(encoded)).toThrow(/16-bit PCM/);
  });
});
