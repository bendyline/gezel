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

import {
  type SpeechActivityMonitor,
  createMicrophoneSpeechActivityMonitor,
} from './microphone-speech-activity.js';

export interface ProgressiveSpeechToTextOptions {
  stream: MediaStream;
  mimeType?: string;
  /** Maximum take length while speech is continuous. */
  segmentMs?: number;
  /** Silence after speech that flushes the current phrase. */
  speechPauseMs?: number;
  /** Minimum phrase length before a micropause may flush it. */
  minSegmentMs?: number;
  /** Silence after any speech that finishes the narration session. */
  longPauseMs?: number;
  activityMonitor?: SpeechActivityMonitor | null;
  transcribe: (blob: Blob, mimeType: string, signal: AbortSignal) => Promise<string>;
  onTranscript: (text: string) => void;
  onError: (error: Error) => void;
  onLongPause?: (hadTranscript: boolean) => void;
  onAudioLevel?: (level: number) => void;
}

// Voice pauses usually give Whisper cleaner phrase boundaries than an
// arbitrary timer. The ceiling remains as a fallback for continuous speech.
const DEFAULT_SEGMENT_MS = 2_500;
const DEFAULT_SPEECH_PAUSE_MS = 350;
const DEFAULT_MIN_SEGMENT_MS = 650;
const DEFAULT_LONG_PAUSE_MS = 10_000;

export class ProgressiveSpeechToText {
  private readonly stream: MediaStream;
  private readonly mimeType: string;
  private readonly segmentMs: number;
  private readonly speechPauseMs: number;
  private readonly minSegmentMs: number;
  private readonly longPauseMs: number;
  private readonly transcribe: ProgressiveSpeechToTextOptions['transcribe'];
  private readonly onTranscript: ProgressiveSpeechToTextOptions['onTranscript'];
  private readonly onError: ProgressiveSpeechToTextOptions['onError'];
  private readonly onLongPause: ProgressiveSpeechToTextOptions['onLongPause'];
  private readonly onAudioLevel: ProgressiveSpeechToTextOptions['onAudioLevel'];
  private readonly abortController = new AbortController();
  private activityMonitor: SpeechActivityMonitor | null;
  private activityMonitorStarted = false;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private segmentTimer: ReturnType<typeof setTimeout> | null = null;
  private transcriptionQueue = Promise.resolve();
  private stopPromise: Promise<void> | null = null;
  private resolveStop: (() => void) | null = null;
  private finalSegmentRequested = false;
  private segmentStartedAt = 0;
  private segmentHasSpeech = false;
  private currentlySpeaking = false;
  private lastSpeechAt: number | null = null;
  private confirmedSilenceMs = 0;
  private hasTranscript = false;
  private longPauseNotified = false;
  private disposed = false;

  constructor(options: ProgressiveSpeechToTextOptions) {
    this.stream = options.stream;
    this.mimeType = options.mimeType ?? '';
    this.segmentMs = options.segmentMs ?? DEFAULT_SEGMENT_MS;
    this.speechPauseMs = options.speechPauseMs ?? DEFAULT_SPEECH_PAUSE_MS;
    this.minSegmentMs = options.minSegmentMs ?? DEFAULT_MIN_SEGMENT_MS;
    this.longPauseMs = options.longPauseMs ?? DEFAULT_LONG_PAUSE_MS;
    this.activityMonitor =
      options.activityMonitor === undefined
        ? createMicrophoneSpeechActivityMonitor(options.stream)
        : options.activityMonitor;
    this.transcribe = options.transcribe;
    this.onTranscript = options.onTranscript;
    this.onError = options.onError;
    this.onLongPause = options.onLongPause;
    this.onAudioLevel = options.onAudioLevel;
  }

  start(): void {
    if (this.disposed || this.recorder) return;
    this.startSegment();
    this.startActivityMonitor();
  }

  /** Stop capture, release the microphone, and wait for queued STT work. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.finalSegmentRequested = true;
    this.stopActivityMonitor();
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
    this.stopActivityMonitor();
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
    this.segmentStartedAt = Date.now();
    this.segmentHasSpeech = this.currentlySpeaking;
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
      const capturedMs = Math.max(0, Date.now() - this.segmentStartedAt);
      this.chunks = [];

      // Start the next self-contained take before doing any STT work so the
      // local/remote engine's latency never leaves the microphone idle.
      if (!this.finalSegmentRequested) this.startSegment();
      // The energy meter suggests clean phrase boundaries; it never decides
      // that audio is disposable. Quiet speech can fall below a local RMS
      // threshold while Whisper still understands it perfectly.
      if (blob.size > 0) this.enqueueTranscription(blob, type, capturedMs);
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

  private startActivityMonitor(): void {
    if (!this.activityMonitor || this.activityMonitorStarted) return;
    try {
      this.activityMonitor.start((speaking, level) => {
        this.onAudioLevel?.(level);
        this.onSpeechActivity(speaking);
      });
      this.activityMonitorStarted = true;
    } catch {
      // Web Audio can be unavailable even when MediaRecorder works. Retain the
      // maximum-duration segmentation path instead of failing narration.
      this.activityMonitor.stop();
      this.activityMonitor = null;
    }
  }

  private stopActivityMonitor(): void {
    this.activityMonitor?.stop();
  }

  private onSpeechActivity(speaking: boolean): void {
    if (this.disposed || this.finalSegmentRequested) return;
    const now = Date.now();
    this.currentlySpeaking = speaking;
    if (speaking) {
      this.segmentHasSpeech = true;
      this.lastSpeechAt = now;
      this.longPauseNotified = false;
      return;
    }
    if (this.lastSpeechAt === null) return;

    const silenceMs = now - this.lastSpeechAt;
    if (
      this.segmentHasSpeech &&
      now - this.segmentStartedAt >= this.minSegmentMs &&
      silenceMs >= this.speechPauseMs
    ) {
      this.flushCurrentSegment();
    }
  }

  private flushCurrentSegment(): void {
    const recorder = this.recorder;
    if (!recorder || recorder.state !== 'recording') return;
    this.clearSegmentTimer();
    recorder.stop();
  }

  private enqueueTranscription(blob: Blob, mimeType: string, capturedMs: number): void {
    this.transcriptionQueue = this.transcriptionQueue.then(async () => {
      if (this.disposed) return;
      try {
        const text = normalizeSpeechTranscript(
          await this.transcribe(blob, mimeType, this.abortController.signal),
        );
        if (this.disposed) return;
        if (text) {
          this.confirmedSilenceMs = 0;
          this.hasTranscript = true;
          this.longPauseNotified = false;
          this.onTranscript(text);
          return;
        }
        this.confirmedSilenceMs += capturedMs;
        if (
          !this.longPauseNotified &&
          this.onLongPause &&
          this.confirmedSilenceMs >= this.longPauseMs
        ) {
          this.longPauseNotified = true;
          this.onLongPause(this.hasTranscript);
        }
      } catch (caught) {
        if (this.disposed || this.abortController.signal.aborted) return;
        this.onError(caught instanceof Error ? caught : new Error(String(caught)));
      }
    });
  }

  private async finish(): Promise<void> {
    this.clearSegmentTimer();
    this.stopActivityMonitor();
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

/** Defense in depth for remote/older STT servers that return Whisper's sentinel. */
export function normalizeSpeechTranscript(value: string): string {
  const text = value.trim();
  return /^\[\s*BLANK_AUDIO\s*\]$/i.test(text) ? '' : text;
}
