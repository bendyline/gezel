import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProgressiveNarrationPlayer } from './progressive-narration-player.js';

class FakeBufferSource extends EventTarget {
  buffer: AudioBuffer | null = null;
  readonly starts: Array<{ when: number; offset: number }> = [];

  connect(): void {}

  start(when = 0, offset = 0): void {
    this.starts.push({ when, offset });
  }

  stop(): void {}
}

class FakeAudioContext {
  static last: FakeAudioContext | null = null;
  currentTime = 0;
  destination = {} as AudioDestinationNode;
  readonly sources: FakeBufferSource[] = [];

  constructor() {
    FakeAudioContext.last = this;
  }

  async resume(): Promise<void> {}
  async close(): Promise<void> {}

  async decodeAudioData(): Promise<AudioBuffer> {
    return { duration: 5 } as AudioBuffer;
  }

  createBufferSource(): AudioBufferSourceNode {
    const source = new FakeBufferSource();
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }
}

describe('ProgressiveNarrationPlayer', () => {
  beforeEach(() => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('plays decoded sentence chunks on one seekable buffered timeline', async () => {
    const snapshots = vi.fn();
    const player = ProgressiveNarrationPlayer.create(snapshots);
    expect(player).not.toBeNull();

    await player!.appendWav(0, new ArrayBuffer(8));
    await player!.appendWav(1, new ArrayBuffer(8));
    expect(player!.snapshot().bufferedDuration).toBe(10);

    await expect(player!.play()).resolves.toBe(true);
    expect(FakeAudioContext.last?.sources).toHaveLength(2);
    FakeAudioContext.last!.currentTime = 2.025;
    expect(player!.snapshot().currentTime).toBeCloseTo(2, 2);

    player!.seek(7);
    await Promise.resolve();
    expect(player!.snapshot().currentTime).toBe(7);
    player!.pause();
    expect(player!.snapshot().isPlaying).toBe(false);

    player!.finish();
    expect(player!.snapshot().complete).toBe(true);
    player!.dispose();
  });
});
