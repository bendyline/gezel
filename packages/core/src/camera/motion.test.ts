import { describe, expect, it } from 'vitest';
import { EpisodeTracker } from './episode.js';
import { type GrayFrame, MotionDetector } from './motion.js';

const W = 160;
const H = 90;

/** A mid-gray room with a little deterministic sensor noise. */
function room(seed: number, base = 110): Uint8Array {
  const data = new Uint8Array(W * H);
  let s = seed;
  for (let i = 0; i < data.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    data[i] = base + ((s >> 16) % 7) - 3;
  }
  return data;
}

/** Paint a dark square "cat" at (x, y). */
function withCat(data: Uint8Array, x: number, y: number, size = 18): Uint8Array {
  const out = new Uint8Array(data);
  for (let yy = y; yy < Math.min(H, y + size); yy++) {
    for (let xx = x; xx < Math.min(W, x + size); xx++) out[yy * W + xx] = 30;
  }
  return out;
}

const frame = (data: Uint8Array): GrayFrame => ({ width: W, height: H, data });

function warm(det: MotionDetector, frames = 10): void {
  for (let i = 0; i < frames; i++) det.feed(frame(room(i)));
}

describe('MotionDetector', () => {
  it('reports nothing for a still room with sensor noise', () => {
    const det = new MotionDetector({ sensitivity: 'high' });
    for (let i = 0; i < 40; i++) {
      const r = det.feed(frame(room(i)));
      expect(r.moving).toBe(false);
      expect(r.present).toBe(false);
    }
  });

  it('ignores scattered single-pixel noise that adds up to a lot of change', () => {
    const det = new MotionDetector({ sensitivity: 'high' });
    warm(det);
    const speckled = room(99);
    for (let i = 0; i < speckled.length; i += 37) speckled[i] = 250;
    const r = det.feed(frame(speckled));
    expect(r.moving).toBe(false);
  });

  it('sees a subject walking in', () => {
    const det = new MotionDetector({ sensitivity: 'medium' });
    warm(det);
    const r = det.feed(frame(withCat(room(50), 20, 30)));
    expect(r.moving).toBe(true);
    expect(r.present).toBe(true);
    expect(r.motion).toBeGreaterThan(0.015);
  });

  it('keeps presence while a subject sits still after motion stops', () => {
    const det = new MotionDetector({ sensitivity: 'medium' });
    warm(det);
    // Walks in across three positions, then squats in one place.
    det.feed(frame(withCat(room(60), 10, 30)));
    det.feed(frame(withCat(room(61), 40, 30)));
    let last = det.feed(frame(withCat(room(62), 70, 30)));
    for (let i = 0; i < 60; i++) last = det.feed(frame(withCat(room(63 + i), 70, 30)));
    expect(last.moving).toBe(false);
    expect(last.present).toBe(true);
  });

  it('treats a lighting change as a scene change, not motion', () => {
    const det = new MotionDetector({ sensitivity: 'high' });
    warm(det);
    const r = det.feed(frame(room(70, 200)));
    expect(r.sceneChange).toBe(true);
    expect(r.moving).toBe(false);
    // The model re-seeded on the bright room: the next bright frame is quiet.
    expect(det.feed(frame(room(71, 200))).moving).toBe(false);
  });

  it('compensates a slow uniform exposure drift in presence', () => {
    const det = new MotionDetector({ sensitivity: 'medium' });
    warm(det);
    let r = det.feed(frame(room(80)));
    for (let step = 0; step < 30; step++) r = det.feed(frame(room(81 + step, 110 + step)));
    expect(r.present).toBe(false);
  });

  it('forgets a subject once the reference is refreshed', () => {
    const det = new MotionDetector({ sensitivity: 'medium' });
    warm(det);
    for (let i = 0; i < 5; i++) det.feed(frame(withCat(room(90 + i), 50, 40)));
    // Long enough for the slow foreground rate to fold the bag into the background.
    for (let i = 0; i < 4000; i++) det.feed(frame(withCat(room(i), 50, 40)));
    det.refreshReference();
    expect(det.feed(frame(withCat(room(7), 50, 40))).present).toBe(false);
  });
});

describe('EpisodeTracker', () => {
  const quiet = {
    motion: 0,
    presence: 0,
    changed: 0,
    moving: false,
    present: false,
    sceneChange: false,
  };
  const moving = { ...quiet, motion: 0.05, presence: 0.05, moving: true, present: true };
  const still = { ...quiet, presence: 0.05, present: true };

  it('needs two of three frames to start an episode', () => {
    const t = new EpisodeTracker({ newId: () => 'ep1' });
    expect(t.feed(moving, 0)).toBeNull();
    expect(t.feed(quiet, 500)).toBeNull();
    const started = t.feed(moving, 1000);
    expect(started?.kind).toBe('started');
    expect(t.current?.id).toBe('ep1');
  });

  it('one stray frame never starts an episode', () => {
    const t = new EpisodeTracker();
    expect(t.feed(moving, 0)).toBeNull();
    expect(t.feed(quiet, 500)).toBeNull();
    expect(t.feed(quiet, 1000)).toBeNull();
    expect(t.feed(moving, 1500)).toBeNull();
    expect(t.current).toBeNull();
  });

  it('stays open while something is present but still, then ends when quiet', () => {
    const t = new EpisodeTracker({ newId: () => 'ep' });
    t.feed(moving, 0);
    t.feed(moving, 500);
    for (let at = 1000; at < 60_000; at += 500) expect(t.feed(still, at)).toBeNull();
    expect(t.current).not.toBeNull();
    t.feed(quiet, 60_000);
    const ended = t.feed(quiet, 68_500);
    expect(ended).toMatchObject({ kind: 'ended', reason: 'quiet' });
  });

  it('ends a motionless presence after stillMs and asks for a reference refresh', () => {
    const t = new EpisodeTracker({ tuning: { stillMs: 10_000 } });
    t.feed(moving, 0);
    t.feed(moving, 500);
    let ended = null;
    for (let at = 1000; at <= 12_000 && !ended; at += 500) ended = t.feed(still, at);
    expect(ended).toMatchObject({ kind: 'ended', reason: 'still' });
    expect(t.takeReferenceRefresh(12_000, true)).toBe(true);
  });

  it('refreshes the reference after a long quiet stretch with no episode', () => {
    const t = new EpisodeTracker({ tuning: { referenceRefreshMs: 60_000 } });
    t.feed(quiet, 0);
    expect(t.takeReferenceRefresh(30_000)).toBe(false);
    expect(t.takeReferenceRefresh(61_000)).toBe(true);
    expect(t.takeReferenceRefresh(62_000)).toBe(false);
  });

  it('caps an episode at its maximum length', () => {
    const t = new EpisodeTracker({ tuning: { maxEpisodeMs: 5_000 } });
    t.feed(moving, 0);
    t.feed(moving, 500);
    let ended = null;
    for (let at = 1000; at <= 6000 && !ended; at += 500) ended = t.feed(moving, at);
    expect(ended).toMatchObject({ kind: 'ended', reason: 'max-length' });
  });

  it('a scene change does not start an episode', () => {
    const t = new EpisodeTracker();
    const flash = { ...moving, sceneChange: true };
    t.feed(flash, 0);
    t.feed(flash, 500);
    expect(t.feed(flash, 1000)).toBeNull();
    expect(t.current).toBeNull();
  });
});
