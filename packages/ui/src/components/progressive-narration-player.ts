interface BufferedAudioChunk {
  index: number;
  start: number;
  buffer: AudioBuffer;
}

export interface ProgressiveNarrationSnapshot {
  currentTime: number;
  bufferedDuration: number;
  isPlaying: boolean;
  waitingForAudio: boolean;
  complete: boolean;
}

type AudioContextConstructor = new () => AudioContext;

/**
 * Sentence-buffered Web Audio player used while Kokoro is still synthesizing.
 * Chunks share one timeline, so newly decoded sentences can be scheduled after
 * already-playing audio without restarting the sound.
 */
export class ProgressiveNarrationPlayer {
  static create(
    onChange: (snapshot: ProgressiveNarrationSnapshot) => void,
  ): ProgressiveNarrationPlayer | null {
    const scope = globalThis as typeof globalThis & {
      webkitAudioContext?: AudioContextConstructor;
    };
    const Context = scope.AudioContext ?? scope.webkitAudioContext;
    if (!Context) return null;
    try {
      return new ProgressiveNarrationPlayer(new Context(), onChange);
    } catch {
      return null;
    }
  }

  private readonly chunks: BufferedAudioChunk[] = [];
  private readonly pending = new Map<number, AudioBuffer>();
  private readonly sources = new Set<AudioBufferSourceNode>();
  private bufferedDuration = 0;
  private playbackOffset = 0;
  private playbackStartedAt = 0;
  private playing = false;
  private complete = false;
  private disposed = false;
  private endTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    private readonly context: AudioContext,
    private readonly onChange: (snapshot: ProgressiveNarrationSnapshot) => void,
  ) {}

  /** Call synchronously from the Narrate click to retain browser playback permission. */
  prime(): void {
    void this.context.resume().catch(() => undefined);
  }

  async appendWav(index: number, wav: ArrayBuffer): Promise<ProgressiveNarrationSnapshot> {
    if (this.disposed || index < this.chunks.length || this.pending.has(index))
      return this.snapshot();
    const decoded = await this.context.decodeAudioData(wav.slice(0));
    if (this.disposed) return this.snapshot();
    this.pending.set(index, decoded);

    while (this.pending.has(this.chunks.length)) {
      const nextIndex = this.chunks.length;
      const buffer = this.pending.get(nextIndex)!;
      this.pending.delete(nextIndex);
      const chunk = { index: nextIndex, start: this.bufferedDuration, buffer };
      this.chunks.push(chunk);
      this.bufferedDuration += buffer.duration;
      if (this.playing) this.scheduleChunk(chunk);
    }
    this.refreshEndTimer();
    this.emit();
    return this.snapshot();
  }

  async play(): Promise<boolean> {
    if (this.disposed || this.bufferedDuration <= 0) return false;
    if (this.playing) return true;
    if (this.playbackOffset >= this.bufferedDuration - 0.02) {
      if (!this.complete) {
        this.emit();
        return false;
      }
      this.playbackOffset = 0;
    }
    await this.context.resume();
    this.stopSources();
    this.playing = true;
    this.playbackStartedAt = this.context.currentTime + 0.025;
    for (const chunk of this.chunks) this.scheduleChunk(chunk);
    this.refreshEndTimer();
    this.emit();
    return true;
  }

  pause(): void {
    if (!this.playing) return;
    this.playbackOffset = this.currentTime();
    this.playing = false;
    this.stopSources();
    this.clearEndTimer();
    this.emit();
  }

  seek(seconds: number): void {
    const wasPlaying = this.playing;
    this.playbackOffset = Math.max(0, Math.min(this.bufferedDuration, seconds));
    this.playing = false;
    this.stopSources();
    this.clearEndTimer();
    if (wasPlaying) void this.play();
    else this.emit();
  }

  finish(): void {
    this.complete = true;
    this.refreshEndTimer();
    this.emit();
  }

  snapshot(): ProgressiveNarrationSnapshot {
    const currentTime = this.currentTime();
    return {
      currentTime,
      bufferedDuration: this.bufferedDuration,
      isPlaying: this.playing,
      waitingForAudio:
        !this.complete &&
        !this.playing &&
        this.bufferedDuration > 0 &&
        currentTime >= this.bufferedDuration - 0.05,
      complete: this.complete,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.playing = false;
    this.stopSources();
    this.clearEndTimer();
    void this.context.close().catch(() => undefined);
  }

  private currentTime(): number {
    if (!this.playing) return this.playbackOffset;
    return Math.min(
      this.bufferedDuration,
      this.playbackOffset + Math.max(0, this.context.currentTime - this.playbackStartedAt),
    );
  }

  private scheduleChunk(chunk: BufferedAudioChunk): void {
    const chunkEnd = chunk.start + chunk.buffer.duration;
    if (!this.playing || chunkEnd <= this.playbackOffset + 0.005) return;

    let sourceOffset = Math.max(0, this.playbackOffset - chunk.start);
    let when = this.playbackStartedAt + Math.max(0, chunk.start - this.playbackOffset);
    if (when < this.context.currentTime) {
      sourceOffset += this.context.currentTime - when;
      when = this.context.currentTime;
    }
    if (sourceOffset >= chunk.buffer.duration - 0.005) return;

    const source = this.context.createBufferSource();
    source.buffer = chunk.buffer;
    source.connect(this.context.destination);
    source.addEventListener('ended', () => this.sources.delete(source), { once: true });
    this.sources.add(source);
    source.start(when, sourceOffset);
  }

  private refreshEndTimer(): void {
    this.clearEndTimer();
    if (!this.playing) return;
    const remainingMs = Math.max(20, (this.bufferedDuration - this.currentTime()) * 1000 + 40);
    this.endTimer = setTimeout(() => {
      if (!this.playing) return;
      const now = this.currentTime();
      if (now < this.bufferedDuration - 0.05) {
        this.refreshEndTimer();
        return;
      }
      this.playbackOffset = this.bufferedDuration;
      this.playing = false;
      this.stopSources();
      this.clearEndTimer();
      this.emit();
    }, remainingMs);
  }

  private stopSources(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // A source that naturally ended may already be stopped.
      }
    }
    this.sources.clear();
  }

  private clearEndTimer(): void {
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
  }

  private emit(): void {
    if (!this.disposed) this.onChange(this.snapshot());
  }
}
