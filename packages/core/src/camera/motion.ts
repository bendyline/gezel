import type { CameraSensitivity } from '../schemas/devices.js';

/**
 * Cheap algorithmic motion and presence detection over tiny grayscale frames
 * (the camera pipeline feeds 160x90). Runs per frame in well under a
 * millisecond, so it decides — instead of the vision model — whether a frame
 * is worth a look.
 *
 * Two readings, because they answer different questions:
 *  - **motion**: what changed since the previous frame. Ends the moment the
 *    subject stops moving.
 *  - **presence**: what differs from a reference of the *empty* scene. Stays
 *    up while something that walked in stays put — a cat squatting in the
 *    middle of the floor is motionless, and that is exactly the moment worth
 *    reviewing.
 *
 * Both score the largest connected blob rather than the total changed
 * fraction, so sensor noise sprinkled across the frame never adds up to a
 * subject. A frame where most pixels change at once is a lighting change
 * (a lamp, the IR switch, auto-exposure) and re-seeds the model instead of
 * reporting motion.
 */

export interface GrayFrame {
  width: number;
  height: number;
  /** One byte per pixel, row-major, `width * height` long. */
  data: Uint8Array;
}

export interface MotionTuning {
  /** Minimum per-pixel difference (0-255) that counts as change. */
  pixelThreshold: number;
  /** Largest changed blob, as a fraction of the frame, that counts as a subject. */
  minBlobFraction: number;
}

export const MOTION_TUNING: Readonly<Record<CameraSensitivity, MotionTuning>> = {
  low: { pixelThreshold: 32, minBlobFraction: 0.02 },
  medium: { pixelThreshold: 24, minBlobFraction: 0.008 },
  high: { pixelThreshold: 16, minBlobFraction: 0.003 },
};

export interface MotionReading {
  /** Largest moving blob as a fraction of the frame (0..1). */
  motion: number;
  /** Largest blob that differs from the empty-scene reference (0..1). */
  presence: number;
  /** Fraction of all pixels that differ from the background. */
  changed: number;
  moving: boolean;
  present: boolean;
  /** Most of the frame changed at once; the model re-seeded and reports nothing. */
  sceneChange: boolean;
}

export interface MotionDetectorOptions {
  sensitivity: CameraSensitivity;
  /** Background learning rate for pixels that are not foreground. */
  backgroundRate?: number;
  /**
   * Learning rate for foreground pixels. Far slower, so a subject that stops
   * is not absorbed into the background within seconds — but nonzero, so an
   * object that is moved and left (a bag on the floor) eventually is.
   */
  foregroundRate?: number;
  /** Changed fraction above which a frame is treated as a lighting change. */
  sceneChangeFraction?: number;
}

const QUIET: MotionReading = Object.freeze({
  motion: 0,
  presence: 0,
  changed: 0,
  moving: false,
  present: false,
  sceneChange: false,
});

export class MotionDetector {
  private tuning: MotionTuning;
  private readonly backgroundRate: number;
  private readonly foregroundRate: number;
  private readonly sceneChangeFraction: number;
  private width = 0;
  private height = 0;
  private background: Float32Array | null = null;
  private reference: Uint8Array | null = null;
  private referenceMean = 0;
  /** Running mean of |frame - background| over background pixels. */
  private noise = 0;
  private blurred: Uint8Array = new Uint8Array(0);
  private previous: Uint8Array = new Uint8Array(0);
  private mask: Uint8Array = new Uint8Array(0);
  private presenceMask: Uint8Array = new Uint8Array(0);
  private stack: Int32Array = new Int32Array(0);

  constructor(opts: MotionDetectorOptions) {
    this.tuning = MOTION_TUNING[opts.sensitivity];
    this.backgroundRate = opts.backgroundRate ?? 0.05;
    this.foregroundRate = opts.foregroundRate ?? 0.002;
    this.sceneChangeFraction = opts.sceneChangeFraction ?? 0.5;
  }

  setSensitivity(sensitivity: CameraSensitivity): void {
    this.tuning = MOTION_TUNING[sensitivity];
  }

  /** Forget everything; the next frame seeds a fresh model. */
  reset(): void {
    this.background = null;
    this.reference = null;
    this.noise = 0;
  }

  /**
   * Adopt the current background as the empty scene. The pipeline calls this
   * after a long quiet spell, or when a review found nothing notable — the
   * only two moments it can trust that nothing is standing in view.
   */
  refreshReference(): void {
    if (!this.background) return;
    const ref = this.reference ?? new Uint8Array(this.background.length);
    let sum = 0;
    for (let i = 0; i < this.background.length; i++) {
      const v = Math.round(this.background[i] as number);
      ref[i] = v;
      sum += v;
    }
    this.reference = ref;
    this.referenceMean = sum / ref.length;
  }

  feed(frame: GrayFrame): MotionReading {
    const n = frame.width * frame.height;
    if (n <= 0 || frame.data.length < n) return QUIET;
    if (frame.width !== this.width || frame.height !== this.height || !this.background) {
      this.seed(frame);
      return QUIET;
    }
    const f = this.blur(frame);
    const bg = this.background;
    const prev = this.previous;
    const threshold = Math.max(this.tuning.pixelThreshold, Math.round(this.noise * 3));

    // Motion: frame-to-frame difference. A subject that stops stops moving
    // here at once, whatever the background has or has not learned yet.
    let changedCount = 0;
    let sum = 0;
    let quietDiff = 0;
    let quietCount = 0;
    for (let i = 0; i < n; i++) {
      const v = f[i] as number;
      sum += v;
      const d = Math.abs(v - (prev[i] as number));
      if (d > threshold) {
        this.mask[i] = 1;
        changedCount++;
      } else {
        this.mask[i] = 0;
        quietDiff += d;
        quietCount++;
      }
    }
    const changed = changedCount / n;
    if (changed > this.sceneChangeFraction) {
      this.seedFrom(f);
      return { ...QUIET, changed, sceneChange: true };
    }
    if (quietCount > 0) {
      const frameNoise = quietDiff / quietCount;
      this.noise = this.noise === 0 ? frameNoise : this.noise * 0.95 + frameNoise * 0.05;
    }
    const motion = changedCount > 0 ? this.largestBlob(this.mask) / n : 0;

    // Presence: difference from the empty scene, compensating a uniform
    // exposure drift so a brighter afternoon does not read as "something is
    // here".
    let presence = 0;
    let presentCount = 0;
    if (this.reference) {
      const shift = sum / n - this.referenceMean;
      for (let i = 0; i < n; i++) {
        const d = Math.abs((f[i] as number) - (this.reference[i] as number) - shift);
        if (d > threshold) {
          this.presenceMask[i] = 1;
          presentCount++;
        } else {
          this.presenceMask[i] = 0;
        }
      }
      presence = presentCount > 0 ? this.largestBlob(this.presenceMask) / n : 0;
    }

    // The background is the candidate empty scene. Anything moving or
    // standing in view learns into it slowly, so a still subject is not
    // absorbed within seconds — the reference is refreshed from it only when
    // the pipeline trusts the room is empty.
    for (let i = 0; i < n; i++) {
      const rate = this.mask[i] || this.presenceMask[i] ? this.foregroundRate : this.backgroundRate;
      const b = bg[i] as number;
      bg[i] = b + ((f[i] as number) - b) * rate;
    }
    prev.set(f);

    return {
      motion,
      presence,
      changed,
      moving: motion >= this.tuning.minBlobFraction,
      present: presence >= this.tuning.minBlobFraction,
      sceneChange: false,
    };
  }

  private seed(frame: GrayFrame): void {
    this.width = frame.width;
    this.height = frame.height;
    const n = frame.width * frame.height;
    this.blurred = new Uint8Array(n);
    this.mask = new Uint8Array(n);
    this.presenceMask = new Uint8Array(n);
    this.previous = new Uint8Array(n);
    this.stack = new Int32Array(n);
    this.seedFrom(this.blur(frame));
  }

  private seedFrom(f: Uint8Array): void {
    const bg = new Float32Array(f.length);
    for (let i = 0; i < f.length; i++) bg[i] = f[i] as number;
    this.background = bg;
    this.previous.set(f);
    this.presenceMask.fill(0);
    this.noise = 0;
    this.refreshReference();
  }

  /** 3x3 box blur with clamped edges; knocks single-pixel sensor noise flat. */
  private blur(frame: GrayFrame): Uint8Array {
    const { width: w, height: h, data } = frame;
    const out = this.blurred.length === w * h ? this.blurred : new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = y > 0 ? y - 1 : 0;
      const y1 = y < h - 1 ? y + 1 : h - 1;
      for (let x = 0; x < w; x++) {
        const x0 = x > 0 ? x - 1 : 0;
        const x1 = x < w - 1 ? x + 1 : w - 1;
        let s = 0;
        let c = 0;
        for (let yy = y0; yy <= y1; yy++) {
          const row = yy * w;
          for (let xx = x0; xx <= x1; xx++) {
            s += data[row + xx] as number;
            c++;
          }
        }
        out[y * w + x] = Math.round(s / c);
      }
    }
    this.blurred = out;
    return out;
  }

  /**
   * Size of the largest 4-connected component of `mask`. Visited pixels are
   * marked 2, so the mask still reads nonzero wherever something changed.
   */
  private largestBlob(mask: Uint8Array): number {
    const w = this.width;
    const h = this.height;
    const stack = this.stack;
    let best = 0;
    for (let start = 0; start < mask.length; start++) {
      if (mask[start] !== 1) continue;
      let size = 0;
      let top = 0;
      stack[top++] = start;
      mask[start] = 2;
      while (top > 0) {
        const i = stack[--top] as number;
        size++;
        const x = i % w;
        const y = (i - x) / w;
        if (x > 0 && mask[i - 1] === 1) {
          mask[i - 1] = 2;
          stack[top++] = i - 1;
        }
        if (x < w - 1 && mask[i + 1] === 1) {
          mask[i + 1] = 2;
          stack[top++] = i + 1;
        }
        if (y > 0 && mask[i - w] === 1) {
          mask[i - w] = 2;
          stack[top++] = i - w;
        }
        if (y < h - 1 && mask[i + w] === 1) {
          mask[i + w] = 2;
          stack[top++] = i + w;
        }
      }
      if (size > best) best = size;
    }
    return best;
  }
}
