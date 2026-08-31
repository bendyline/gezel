import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProgressiveSpeechToText } from './progressive-speech-to-text.js';

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = () => true;

  readonly stream: MediaStream;
  readonly mimeType: string;
  state: RecordingState = 'inactive';
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;
  onstart: ((event: Event) => void) | null = null;

  constructor(stream: MediaStream, options?: MediaRecorderOptions) {
    this.stream = stream;
    this.mimeType = options?.mimeType ?? 'audio/webm';
    FakeMediaRecorder.instances.push(this);
  }

  start() {
    this.state = 'recording';
    this.onstart?.(new Event('start'));
  }

  stop() {
    this.state = 'inactive';
    queueMicrotask(() => {
      const data = new Blob([`take-${FakeMediaRecorder.instances.indexOf(this)}`], {
        type: this.mimeType,
      });
      this.ondataavailable?.({ data } as BlobEvent);
      this.onstop?.(new Event('stop'));
    });
  }
}

describe('ProgressiveSpeechToText', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeMediaRecorder.instances = [];
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('transcribes self-contained takes while recording and flushes the final take in order', async () => {
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    const onTranscript = vi.fn();
    const transcribe = vi
      .fn<(blob: Blob, mimeType: string, signal: AbortSignal) => Promise<string>>()
      .mockResolvedValueOnce('first phrase')
      .mockResolvedValueOnce('second phrase');
    const recorder = new ProgressiveSpeechToText({
      stream,
      mimeType: 'audio/webm;codecs=opus',
      segmentMs: 1_000,
      transcribe,
      onTranscript,
      onError: vi.fn(),
    });

    recorder.start();
    expect(FakeMediaRecorder.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();
    expect(FakeMediaRecorder.instances).toHaveLength(2);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith('first phrase');
    expect(stopTrack).not.toHaveBeenCalled();

    await recorder.stop();
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(onTranscript.mock.calls.map(([text]) => text)).toEqual([
      'first phrase',
      'second phrase',
    ]);
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it('aborts pending STT and releases the microphone when cancelled', async () => {
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    const onTranscript = vi.fn();
    const transcribe = vi.fn(async (_blob: Blob, _mime: string, signal: AbortSignal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      return 'too late';
    });
    const recorder = new ProgressiveSpeechToText({
      stream,
      segmentMs: 1_000,
      transcribe,
      onTranscript,
      onError: vi.fn(),
    });

    recorder.start();
    await vi.advanceTimersByTimeAsync(1_000);
    recorder.cancel();
    await Promise.resolve();

    expect(stopTrack).toHaveBeenCalledOnce();
    expect(onTranscript).not.toHaveBeenCalled();
  });
});
