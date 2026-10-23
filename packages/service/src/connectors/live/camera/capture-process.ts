/**
 * A running camera: one ffmpeg process whose two pipes become paired frames
 * (a 160x90 grayscale frame for the motion detector, and the JPEG of the same
 * moment). See ffmpeg-args.ts for why pipes, and why one process per device.
 */

import { type ChildProcess, execFile, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { CameraBackend } from '@bendyline/gezel';
import { createLogger } from '@bendyline/gezel';
import { type CaptureFailureKind, classifyCaptureError } from './discovery-parse.js';
import { ANALYSIS_FRAME_BYTES, captureArgs } from './ffmpeg-args.js';

const log = createLogger('camera');

export interface CameraFrame {
  /** Wall-clock arrival time. */
  at: number;
  /** 160x90 grayscale, one byte per pixel. */
  gray: Uint8Array;
  jpeg: Buffer;
}

export class CaptureError extends Error {
  constructor(
    readonly kind: CaptureFailureKind | 'no-frames' | 'ended',
    message: string,
  ) {
    super(message);
    this.name = 'CaptureError';
  }
}

/** Anything that produces paired frames: ffmpeg, or the simulator. */
export interface FrameSource {
  start(): void;
  stop(): Promise<void>;
  onFrame(cb: (frame: CameraFrame) => void): () => void;
  /** The source ended on its own; `stop()` never reports. */
  onError(cb: (err: CaptureError) => void): () => void;
}

export interface FfmpegSourceOptions {
  ffmpegPath: string;
  backend: CameraBackend;
  device: string;
  marker: string;
  /** Preferred mode; dropped on retry when the camera refuses it. */
  videoSize?: string;
  platform?: NodeJS.Platform;
  /** Injectable for tests. */
  spawnImpl?: typeof spawn;
}

const STDERR_TAIL = 4_000;
/** Above this many unpaired frames on one pipe, the oldest are dropped. */
const MAX_UNPAIRED = 4;

/** Splits an MJPEG byte stream into whole JPEGs (SOI … EOI). */
export class JpegStreamSplitter {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: Buffer[] = [];
    for (;;) {
      const soi = this.buf.indexOf(SOI);
      if (soi < 0) {
        // Keep a trailing 0xFF: it may be the first half of the next SOI.
        this.buf =
          this.buf.length > 0 && this.buf[this.buf.length - 1] === 0xff
            ? this.buf.subarray(-1)
            : Buffer.alloc(0);
        return out;
      }
      // ffmpeg's encoder writes no embedded thumbnails and stuffs 0xFF in
      // entropy data, so the first EOI after an SOI ends the image.
      const eoi = this.buf.indexOf(EOI, soi + 2);
      if (eoi < 0) {
        if (soi > 0) this.buf = this.buf.subarray(soi);
        return out;
      }
      out.push(Buffer.from(this.buf.subarray(soi, eoi + 2)));
      this.buf = this.buf.subarray(eoi + 2);
    }
  }
}

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

/** Cuts the raw grayscale stream into fixed-size frames. */
export class RawFrameSlicer {
  private parts: Buffer[] = [];
  private length = 0;

  constructor(private readonly frameBytes: number = ANALYSIS_FRAME_BYTES) {}

  push(chunk: Buffer): Uint8Array[] {
    this.parts.push(chunk);
    this.length += chunk.length;
    const out: Uint8Array[] = [];
    if (this.length < this.frameBytes) return out;
    let all = Buffer.concat(this.parts, this.length);
    while (all.length >= this.frameBytes) {
      out.push(new Uint8Array(all.subarray(0, this.frameBytes)));
      all = all.subarray(this.frameBytes);
    }
    this.parts = all.length > 0 ? [Buffer.from(all)] : [];
    this.length = all.length;
    return out;
  }
}

export class FfmpegFrameSource implements FrameSource {
  private child: ChildProcess | null = null;
  private stopped = false;
  private stderrTail = '';
  private framesSeen = 0;
  private videoSize: string | undefined;
  private readonly frameListeners = new Set<(f: CameraFrame) => void>();
  private readonly errorListeners = new Set<(e: CaptureError) => void>();
  private grayQueue: Uint8Array[] = [];
  private jpegQueue: Buffer[] = [];

  constructor(private readonly opts: FfmpegSourceOptions) {
    this.videoSize = opts.videoSize;
  }

  onFrame(cb: (f: CameraFrame) => void): () => void {
    this.frameListeners.add(cb);
    return () => this.frameListeners.delete(cb);
  }

  onError(cb: (e: CaptureError) => void): () => void {
    this.errorListeners.add(cb);
    return () => this.errorListeners.delete(cb);
  }

  start(): void {
    if (this.child || this.stopped) return;
    const args = captureArgs(
      {
        backend: this.opts.backend,
        device: this.opts.device,
        ...(this.videoSize ? { videoSize: this.videoSize } : {}),
      },
      { marker: this.opts.marker },
    );
    const child = (this.opts.spawnImpl ?? spawn)(this.opts.ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.stderrTail = '';
    this.grayQueue = [];
    this.jpegQueue = [];
    const slicer = new RawFrameSlicer();
    const splitter = new JpegStreamSplitter();
    child.stdout?.on('data', (chunk: Buffer) => {
      for (const g of slicer.push(chunk)) this.grayQueue.push(g);
      this.pair();
    });
    (child.stdio[3] as Readable | null)?.on('data', (chunk: Buffer) => {
      for (const j of splitter.push(chunk)) this.jpegQueue.push(j);
      this.pair();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL);
    });
    child.on('error', (err) => this.fail(new CaptureError('unknown', err.message)));
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopped) return;
      const kind = classifyCaptureError(this.stderrTail);
      // The camera refused the mode we asked for: try once more with its
      // own default before reporting anything.
      if (kind === 'unsupported-size' && this.videoSize && this.framesSeen === 0) {
        log.info(`camera refused ${this.videoSize}; retrying with its default mode`);
        this.videoSize = undefined;
        this.start();
        return;
      }
      const detail = this.stderrTail.trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 300);
      log.warn(`camera capture ended (code ${code ?? signal}): ${detail}`);
      void this.describeFailure(kind, detail).then((message) =>
        this.fail(new CaptureError(this.framesSeen === 0 ? kind : 'ended', message)),
      );
    });
  }

  private pair(): void {
    while (this.grayQueue.length > 0 && this.jpegQueue.length > 0) {
      const gray = this.grayQueue.shift() as Uint8Array;
      const jpeg = this.jpegQueue.shift() as Buffer;
      this.framesSeen++;
      const frame: CameraFrame = { at: Date.now(), gray, jpeg };
      for (const cb of this.frameListeners) {
        try {
          cb(frame);
        } catch (err) {
          log.warn('camera frame listener threw:', err);
        }
      }
    }
    // The two outputs run in lockstep; a backlog on one side means a frame
    // was lost on the other, and pairing stale frames would misalign every
    // later pair.
    if (this.grayQueue.length > MAX_UNPAIRED) this.grayQueue.splice(0, this.grayQueue.length - 1);
    if (this.jpegQueue.length > MAX_UNPAIRED) this.jpegQueue.splice(0, this.jpegQueue.length - 1);
  }

  private fail(err: CaptureError): void {
    if (this.stopped) return;
    for (const cb of this.errorListeners) cb(err);
  }

  private async describeFailure(kind: CaptureFailureKind, detail: string): Promise<string> {
    const platform = this.opts.platform ?? process.platform;
    if (platform === 'win32' && kind !== 'in-use' && (await windowsCameraBlocked())) {
      return 'Windows is keeping desktop apps away from the camera. Turn on Settings → Privacy & security → Camera → "Let desktop apps access your camera", then resume.';
    }
    switch (kind) {
      case 'not-found':
        return 'The camera could not be opened. Check that it is plugged in.';
      case 'in-use':
        return 'Another app is using the camera.';
      case 'permission':
        return platform === 'darwin'
          ? 'macOS has not allowed Gezel to use the camera. Allow it in System Settings → Privacy & Security → Camera, then resume.'
          : 'This computer did not allow Gezel to use the camera.';
      default:
        return this.framesSeen > 0
          ? 'The camera stopped sending pictures.'
          : `The camera could not be started${detail ? ` (${detail})` : ''}.`;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    this.child = null;
    this.frameListeners.clear();
    this.errorListeners.clear();
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3_000);
      timer.unref?.();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
  }
}

/** Whether Windows' camera privacy switch denies desktop apps. */
export function windowsCameraBlocked(): Promise<boolean> {
  const base =
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\webcam';
  const query = (key: string) =>
    new Promise<string>((resolve) => {
      execFile(
        'reg',
        ['query', key, '/v', 'Value'],
        { timeout: 3_000, windowsHide: true },
        (_e, out) => resolve(String(out ?? '')),
      );
    });
  return Promise.all([query(base), query(`${base}\\NonPackaged`)]).then(
    ([all, desktop]) => /\bDeny\b/.test(all) || /\bDeny\b/.test(desktop),
  );
}
