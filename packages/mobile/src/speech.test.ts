import { describe, expect, it, vi } from 'vitest';
import { type NativeSpeechPlugin, createNativeSpeech } from './speech.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function bridge(): NativeSpeechPlugin {
  return {
    status: vi.fn(),
    transcribe: vi.fn(),
    cancel: vi.fn(async () => {}),
    synthesize: vi.fn(async () => ({
      wav: 'UklGRg==',
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
