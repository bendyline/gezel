/**
 * A camera that is not there: `GEZEL_CAMERA_SIMULATOR=1` adds a "Simulated
 * mud room" to discovery. It replays a small scene on a loop — the empty
 * room, a cat walking in, the cat squatting still, the cat leaving — so the
 * whole pipeline (motion, episodes, review, event records, lookouts) runs in
 * tests, E2E, and evals with no hardware and no vision model.
 *
 * Each JPEG carries the scene step in a comment segment, and
 * {@link simulatedReview} answers from it, standing in for the vision model.
 */

import { createRequire } from 'node:module';
import type { CameraDevice } from '@bendyline/gezel';
import type { CameraFrame, CaptureError, FrameSource } from './capture-process.js';
import { ANALYSIS_HEIGHT, ANALYSIS_WIDTH, CAPTURE_FPS } from './ffmpeg-args.js';

const jpeg = createRequire(import.meta.url)('jpeg-js') as typeof import('jpeg-js');

export const SIMULATED_CAMERA_ID = 'simulator:mud-room';

export const SIMULATED_CAMERA: CameraDevice = {
  id: SIMULATED_CAMERA_ID,
  name: 'Simulated mud room',
  backend: 'simulator',
};

export function cameraSimulatorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.GEZEL_CAMERA_SIMULATOR;
  return !!v && v !== '0' && v !== 'false';
}

export type SimulatedStep = 'empty' | 'walk-in' | 'squat' | 'walk-out';

/** The scene, in seconds per step. One loop is about two minutes. */
export const SIMULATED_SCENE: ReadonlyArray<{ step: SimulatedStep; seconds: number }> = [
  { step: 'empty', seconds: 20 },
  { step: 'walk-in', seconds: 3 },
  { step: 'squat', seconds: 40 },
  { step: 'walk-out', seconds: 3 },
  { step: 'empty', seconds: 50 },
];

const SCENE_SECONDS = SIMULATED_SCENE.reduce((s, x) => s + x.seconds, 0);

/** Where in the scene a frame index falls, and how far into that step. */
export function sceneAt(
  frameIndex: number,
  fps = CAPTURE_FPS,
): { step: SimulatedStep; progress: number } {
  let t = (frameIndex / fps) % SCENE_SECONDS;
  for (const s of SIMULATED_SCENE) {
    if (t < s.seconds) return { step: s.step, progress: t / s.seconds };
    t -= s.seconds;
  }
  return { step: 'empty', progress: 0 };
}

const CAT = 22;

/** The cat's left edge for a step, or null when the room is empty. */
function catX(step: SimulatedStep, progress: number): number | null {
  if (step === 'walk-in') return Math.round(-CAT + progress * (70 + CAT));
  if (step === 'squat') return 70;
  if (step === 'walk-out') return Math.round(70 + progress * (ANALYSIS_WIDTH - 70));
  return null;
}

/** One analysis frame: a floor with mild sensor noise, and maybe a cat. */
export function simulatedGray(frameIndex: number): Uint8Array {
  const { step, progress } = sceneAt(frameIndex);
  const data = new Uint8Array(ANALYSIS_WIDTH * ANALYSIS_HEIGHT);
  let seed = frameIndex * 7919 + 1;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const y = Math.floor(i / ANALYSIS_WIDTH);
    data[i] = (y < 30 ? 150 : 105) + ((seed >> 16) % 5) - 2;
  }
  const x = catX(step, progress);
  if (x !== null) {
    for (let y = 50; y < 50 + CAT; y++) {
      for (let xx = Math.max(0, x); xx < Math.min(ANALYSIS_WIDTH, x + CAT); xx++) {
        data[y * ANALYSIS_WIDTH + xx] = 40;
      }
    }
  }
  return data;
}

const SCALE = 2;

/** The matching JPEG, twice the analysis size, with the step in a comment. */
export function simulatedJpeg(gray: Uint8Array, step: SimulatedStep): Buffer {
  const w = ANALYSIS_WIDTH * SCALE;
  const h = ANALYSIS_HEIGHT * SCALE;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = gray[Math.floor(y / SCALE) * ANALYSIS_WIDTH + Math.floor(x / SCALE)] as number;
      const o = (y * w + x) * 4;
      rgba[o] = v;
      rgba[o + 1] = Math.max(0, v - 8);
      rgba[o + 2] = Math.max(0, v - 18);
      rgba[o + 3] = 255;
    }
  }
  const encoded = Buffer.from(jpeg.encode({ data: rgba, width: w, height: h }, 70).data);
  const text = Buffer.from(`gezel-sim:${step}`, 'ascii');
  const com = Buffer.alloc(4 + text.length);
  com[0] = 0xff;
  com[1] = 0xfe;
  com.writeUInt16BE(text.length + 2, 2);
  text.copy(com, 4);
  return Buffer.concat([encoded.subarray(0, 2), com, encoded.subarray(2)]);
}

/** The scene step a simulated JPEG carries, or null for a real camera's frame. */
export function simulatedStepOf(bytes: Buffer): SimulatedStep | null {
  const head = bytes.subarray(0, 64).toString('latin1');
  const m = /gezel-sim:(empty|walk-in|squat|walk-out)/.exec(head);
  return m ? (m[1] as SimulatedStep) : null;
}

/**
 * The simulator's stand-in for the vision model: the cat is notable whenever
 * it is in view, and every question is a confident yes only while it squats.
 */
export function simulatedReview(
  step: SimulatedStep,
  questionKeys: readonly string[],
): { summary: string; subjects: string[]; notable: boolean; answers: Record<string, unknown> } {
  const squat = step === 'squat';
  const cat = step !== 'empty';
  return {
    summary: squat
      ? 'A gray cat squats in the middle of the mud room floor.'
      : cat
        ? 'A gray cat walks across the mud room.'
        : 'An empty mud room.',
    subjects: cat ? ['cat'] : [],
    notable: cat,
    answers: Object.fromEntries(
      questionKeys.map((k) => [k, { match: squat, confidence: squat ? 'high' : 'medium' }]),
    ),
  };
}

export class SimulatedFrameSource implements FrameSource {
  private timer: ReturnType<typeof setInterval> | null = null;
  private index = 0;
  private readonly frameListeners = new Set<(f: CameraFrame) => void>();

  constructor(private readonly opts: { fps?: number; startAt?: number } = {}) {
    this.index = opts.startAt ?? 0;
  }

  onFrame(cb: (f: CameraFrame) => void): () => void {
    this.frameListeners.add(cb);
    return () => this.frameListeners.delete(cb);
  }

  onError(_cb: (e: CaptureError) => void): () => void {
    return () => {};
  }

  /** Produce the next frame now (tests drive the scene by hand). */
  tick(at = Date.now()): CameraFrame {
    const gray = simulatedGray(this.index);
    const frame = { at, gray, jpeg: simulatedJpeg(gray, sceneAt(this.index).step) };
    this.index++;
    for (const cb of this.frameListeners) cb(frame);
    return frame;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 1000 / (this.opts.fps ?? CAPTURE_FPS));
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.frameListeners.clear();
  }
}
