/**
 * Browser microphone capture split into independently-decodable audio takes.
 *
 * MediaRecorder `timeslice` blobs are not reliably self-contained: after the
 * first chunk, WebM/MP4 metadata may be missing. Progressive STT needs every
 * upload to stand alone, so this recorder stops and immediately replaces the
 * MediaRecorder at each boundary while keeping the same microphone stream.
 * Transcriptions are queued in capture order and delivered as final text
 * fragments that a composer can append without revising earlier dictation.
 */

export interface ProgressiveSpeechToTextOptions {
  stream: MediaStream;
  mimeType?: string;
  segmentMs?: number;
  transcribe: (blob: Blob, mimeType: string, signal: AbortSignal) => Promise<string>;
  onTranscript: (text: string) => void;
  onError: (error: Error) => void;
}

const DEFAULT_SEGMENT_MS = 8_000;

export class ProgressiveSpeechToText {
  private readonly stream: MediaStream;
  private readonly mimeType: string;
  private readonly segmentMs: number;
  private readonly transcribe: ProgressiveSpeechToTextOptions['transcribe'];
  private readonly onTranscript: ProgressiveSpeechToTextOptions['onTranscript'];
  private readonly onError: ProgressiveSpeechToTextOptions['onError'];
  private readonly abortController = new AbortController();
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private segmentTimer: ReturnType<typeof setTimeout> | null = null;
  private transcriptionQueue = Promise.resolve();
  private stopPromise: Promise<void> | null = null;
  private resolveStop: (() => void) | null = null;
  private finalSegmentRequested = false;
  private disposed = false;

  constructor(options: ProgressiveSpeechToTextOptions) {
    this.stream = options.stream;
    this.mimeType = options.mimeType ?? '';
    this.segmentMs = options.segmentMs ?? DEFAULT_SEGMENT_MS;
    this.transcribe = options.transcribe;
    this.onTranscript = options.onTranscript;
    this.onError = options.onError;
  }

  start(): void {
    if (this.disposed || this.recorder) return;
    this.startSegment();
  }

  /** Stop capture, release the microphone, and wait for queued STT work. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.finalSegmentRequested = true;
    this.clearSegmentTimer();
    this.stopPromise = new Promise<void>((resolve) => {
      this.resolveStop = resolve;
    });
    const recorder = this.recorder;
    if (recorder?.state === 'recording') {
      recorder.stop();
    } else if (!recorder) {
      void this.finish();
    }
    return this.stopPromise;
  }

  /** Tear down without delivering any more transcription callbacks. */
  cancel(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController.abort();
    this.clearSegmentTimer();
    const recorder = this.recorder;
    this.recorder = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          // It was already stopping; track teardown below is authoritative.
        }
      }
    }
    this.releaseStream();
    this.resolveStop?.();
    this.resolveStop = null;
  }

  private startSegment(): void {
    if (this.disposed || this.finalSegmentRequested) return;
    const recorderOptions = this.mimeType ? { mimeType: this.mimeType } : undefined;
    const recorder = new MediaRecorder(this.stream, recorderOptions);
    this.recorder = recorder;
    this.chunks = [];
    recorder.ondataavailable = (event) => {
      if (!this.disposed && event.data.size > 0) this.chunks.push(event.data);
    };
    recorder.onerror = (event) => {
      const error = (event as Event & { error?: DOMException }).error;
      this.onError(error ?? new Error('Microphone recording failed.'));
      this.finalSegmentRequested = true;
      this.clearSegmentTimer();
    };
    recorder.onstop = () => {
      if (this.disposed || this.recorder !== recorder) return;
      this.recorder = null;
      const type = recorder.mimeType || this.mimeType || 'audio/webm';
      const blob = new Blob(this.chunks, { type });
      this.chunks = [];

      // Start the next self-contained take before doing any STT work so the
      // local/remote engine's latency never leaves the microphone idle.
      if (!this.finalSegmentRequested) this.startSegment();
      if (blob.size > 0) this.enqueueTranscription(blob, type);
      if (this.finalSegmentRequested) void this.finish();
    };
    recorder.start();
    this.segmentTimer = setTimeout(() => {
      this.segmentTimer = null;
      if (!this.disposed && !this.finalSegmentRequested && recorder.state === 'recording') {
        recorder.stop();
      }
    }, this.segmentMs);
  }

  private enqueueTranscription(blob: Blob, mimeType: string): void {
    this.transcriptionQueue = this.transcriptionQueue.then(async () => {
      if (this.disposed) return;
      try {
        const text = (await this.transcribe(blob, mimeType, this.abortController.signal)).trim();
        if (!this.disposed && text) this.onTranscript(text);
      } catch (caught) {
        if (this.disposed || this.abortController.signal.aborted) return;
        this.onError(caught instanceof Error ? caught : new Error(String(caught)));
      }
    });
  }

  private async finish(): Promise<void> {
    this.clearSegmentTimer();
    this.releaseStream();
    await this.transcriptionQueue;
    if (this.disposed) return;
    this.disposed = true;
    this.resolveStop?.();
    this.resolveStop = null;
  }

  private clearSegmentTimer(): void {
    if (this.segmentTimer === null) return;
    clearTimeout(this.segmentTimer);
    this.segmentTimer = null;
  }

  private releaseStream(): void {
    for (const track of this.stream.getTracks()) track.stop();
  }
}
