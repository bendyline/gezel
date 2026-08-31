import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpeechActivityMonitor } from './microphone-speech-activity.js';
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

class FakeSpeechActivityMonitor implements SpeechActivityMonitor {
  private onActivity: ((speaking: boolean, level: number) => void) | null = null;
  readonly stop = vi.fn();

  start(onActivity: (speaking: boolean, level: number) => void): void {
    this.onActivity = onActivity;
  }

  emit(speaking: boolean, level = speaking ? 0.1 : 0.002): void {
    this.onActivity?.(speaking, level);
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

  it('ignores Whisper blank-audio sentinels and continues with later speech', async () => {
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    const onTranscript = vi.fn();
    const transcribe = vi
      .fn<(blob: Blob, mimeType: string, signal: AbortSignal) => Promise<string>>()
      .mockResolvedValueOnce('[BLANK_AUDIO]')
      .mockResolvedValueOnce('actual speech');
    const recorder = new ProgressiveSpeechToText({
      stream,
      segmentMs: 1_000,
      transcribe,
      onTranscript,
      onError: vi.fn(),
    });

    recorder.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onTranscript).not.toHaveBeenCalled();

    await recorder.stop();
    expect(onTranscript).toHaveBeenCalledOnce();
    expect(onTranscript).toHaveBeenCalledWith('actual speech');
  });

  it('flushes on micropauses and still uploads later speech the meter misses', async () => {
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    const activityMonitor = new FakeSpeechActivityMonitor();
    const onTranscript = vi.fn();
    const onAudioLevel = vi.fn();
    const transcribe = vi
      .fn<(blob: Blob, mimeType: string, signal: AbortSignal) => Promise<string>>()
      .mockResolvedValueOnce('1 2')
      .mockResolvedValueOnce('3 4')
      .mockResolvedValue('');
    const onLongPause = vi.fn();
    const recorder = new ProgressiveSpeechToText({
      stream,
      segmentMs: 1_000,
      speechPauseMs: 400,
      minSegmentMs: 600,
      longPauseMs: 5_000,
      activityMonitor,
      transcribe,
      onTranscript,
      onAudioLevel,
      onError: vi.fn(),
      onLongPause,
    });

    recorder.start();
    activityMonitor.emit(true, 0.2);
    expect(onAudioLevel).toHaveBeenLastCalledWith(0.2);
    await vi.advanceTimersByTimeAsync(400);
    activityMonitor.emit(true);
    await vi.advanceTimersByTimeAsync(200);
    activityMonitor.emit(false);
    await vi.advanceTimersByTimeAsync(150);
    activityMonitor.emit(false);
    expect(FakeMediaRecorder.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(50);
    activityMonitor.emit(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeMediaRecorder.instances).toHaveLength(2);
    expect(onTranscript).toHaveBeenCalledWith('1 2');
    expect(onLongPause).not.toHaveBeenCalled();
    expect(stopTrack).not.toHaveBeenCalled();

    // The energy gate misses the next phrase entirely. Its take must still go
    // to Whisper at the hard boundary instead of being discarded as silence.
    await vi.advanceTimersByTimeAsync(500);
    activityMonitor.emit(false);
    await vi.advanceTimersByTimeAsync(500);
    activityMonitor.emit(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeMediaRecorder.instances).toHaveLength(3);
    expect(onTranscript).toHaveBeenCalledWith('3 4');
    expect(onLongPause).not.toHaveBeenCalled();

    await recorder.stop();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(activityMonitor.stop).toHaveBeenCalled();
  });

  it('finishes only after Whisper confirms a long silence', async () => {
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    const onLongPause = vi.fn();
    const transcribe = vi
      .fn<(blob: Blob, mimeType: string, signal: AbortSignal) => Promise<string>>()
      .mockResolvedValueOnce('one two')
      .mockResolvedValue('');
    const recorder = new ProgressiveSpeechToText({
      stream,
      segmentMs: 1_000,
      longPauseMs: 2_500,
      activityMonitor: null,
      transcribe,
      onTranscript: vi.fn(),
      onError: vi.fn(),
      onLongPause,
    });

    recorder.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(onLongPause).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onLongPause).toHaveBeenCalledOnce();
    expect(onLongPause).toHaveBeenCalledWith(true);
    await recorder.stop();
  });
});
