import { describe, expect, it, vi } from 'vitest';
import { type NativeSpeechPlugin, createNativeSpeech } from './speech.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
/** A real 24 kHz PCM16 WAV, so joining exercises the same path the device does. */
function wavFixture(samples: number): string {
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true);
  view.setUint32(28, 48_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples * 2, true);
  return Buffer.from(bytes).toString('base64');
}

function bridge(): NativeSpeechPlugin {
  return {
    status: vi.fn(),
    transcribe: vi.fn(),
    cancel: vi.fn(async () => {}),
    synthesize: vi.fn(async () => ({
      wav: wavFixture(160),
      meta: {
        voice: 'af_heart',
        model: 'kokoro-82m-v1.0',
        sampleRate: 24000,
        durationSeconds: 1,
        durationMs: 50,
      },
    })),
  };
}
describe('native speech adapter', () => {
  it('holds admission until both inference and cancellation have settled', async () => {
    const native = bridge();
    const speech = createNativeSpeech(native);
    const work = deferred<Awaited<ReturnType<NativeSpeechPlugin['synthesize']>>>();
    const cancellation = deferred<void>();
    const started = deferred<void>();
    vi.mocked(native.synthesize).mockImplementation(async () => {
      started.resolve();
      return work.promise;
    });
    vi.mocked(native.cancel).mockReturnValue(cancellation.promise);
    const controller = new AbortController();
    const pending = speech.synthesize({ text: 'Hello' }, controller.signal);
    const rejected = expect(pending).rejects.toThrow();
    await started.promise;
    controller.abort();
    expect(native.cancel).toHaveBeenCalledWith({
      requestId: vi.mocked(native.synthesize).mock.calls[0]?.[0].requestId,
    });
    await expect(
      speech.synthesize({ text: 'Too soon' }, new AbortController().signal),
    ).rejects.toThrow('already running');
    work.resolve({ wav: 'UklGRg==', meta: {} });
    await Promise.resolve();
    await expect(
      speech.synthesize({ text: 'Still too soon' }, new AbortController().signal),
    ).rejects.toThrow('already running');
    cancellation.resolve();
    await rejected;
  });
  it('preserves native readiness errors for the shared fallback policy', async () => {
    const native = bridge();
    const speech = createNativeSpeech(native);
    vi.mocked(native.synthesize).mockRejectedValue(
      Object.assign(new Error('Assets missing'), { code: 'download-required' }),
    );
    await expect(
      speech.synthesize({ text: 'Hello' }, new AbortController().signal),
    ).rejects.toMatchObject({ name: 'OfflineSpeechError', code: 'download-required' });
  });
  it('rejects malformed recordings before native execution', async () => {
    const native = bridge();
    await expect(
      createNativeSpeech(native).transcribe(
        'system',
        { audio: new Uint8Array([1, 2]), mimeType: 'audio/wav' },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(native.transcribe).not.toHaveBeenCalled();
  });
  it('sends phonemes, never text, and one call per sentence', async () => {
    const native = bridge();
    await createNativeSpeech(native).synthesize(
      { text: 'Hello world. Hello cat.' },
      new AbortController().signal,
    );
    // One inference per sentence, since nothing native splits sentences now.
    expect(native.synthesize).toHaveBeenCalledTimes(2);
    for (const [call] of vi.mocked(native.synthesize).mock.calls) {
      // Text must not cross the bridge: the eSpeak-free frontend runs here.
      expect(call).not.toHaveProperty('text');
      expect(call.tokens.length).toBeGreaterThan(2);
      // Kokoro frames every utterance with its pad token.
      expect(call.tokens.at(0)).toBe(0);
      expect(call.tokens.at(-1)).toBe(0);
    }
  });

  it('reads a British voice from the British dictionary', async () => {
    const native = bridge();
    const speech = createNativeSpeech(native);
    await speech.synthesize({ text: 'hello', voice: 'af_heart' }, new AbortController().signal);
    await speech.synthesize({ text: 'hello', voice: 'bm_george' }, new AbortController().signal);
    const [american, british] = vi.mocked(native.synthesize).mock.calls.map(([c]) => c.tokens);
    expect(british).not.toEqual(american);
  });

  it('validates native status and never invokes inference during a readiness check', async () => {
    const native = bridge();
    const speech = createNativeSpeech(native);
    vi.mocked(native.status).mockResolvedValue({ system: { state: 'cloud' } });
    await expect(speech.status('nl-NL')).rejects.toThrow();
    expect(native.status).toHaveBeenCalledExactlyOnceWith({ language: 'nl-NL' });
    expect(native.transcribe).not.toHaveBeenCalled();
    expect(native.synthesize).not.toHaveBeenCalled();
  });
});
