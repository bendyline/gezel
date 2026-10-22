/**
 * One capture per physical camera. Two bindings on the same webcam (two
 * projects, or two cameras configured over one device) share one ffmpeg and
 * fan its frames out; the process stops when the last binding lets go. Also
 * keeps each camera's newest frame, which is what the live preview and the
 * "look at the camera" tool read — no frame is written to disk for them.
 */

import type { CameraBackend } from '@bendyline/gezel';
import type { CameraFrame, CaptureError, FrameSource } from './capture-process.js';

export interface CameraSourceSpec {
  backend: CameraBackend;
  device: string;
}

export interface CameraLease {
  onFrame(cb: (frame: CameraFrame) => void): void;
  onError(cb: (err: CaptureError) => void): void;
  release(): Promise<void>;
}

interface Entry {
  source: FrameSource;
  refs: number;
  latest: CameraFrame | null;
  unsubscribe: Array<() => void>;
}

export function cameraSourceKey(spec: CameraSourceSpec): string {
  return `${spec.backend}|${spec.device}`;
}

export class CameraSourcePool {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly create: (spec: CameraSourceSpec) => FrameSource | Promise<FrameSource>,
  ) {}

  async acquire(spec: CameraSourceSpec): Promise<CameraLease> {
    const key = cameraSourceKey(spec);
    let entry = this.entries.get(key);
    if (!entry) {
      const source = await this.create(spec);
      const created: Entry = { source, refs: 0, latest: null, unsubscribe: [] };
      created.unsubscribe.push(
        source.onFrame((f) => {
          created.latest = f;
        }),
      );
      // A dead source is dropped from the pool at once, so the next acquire
      // (the host's retry) starts a fresh process instead of joining a corpse.
      created.unsubscribe.push(
        source.onError(() => {
          if (this.entries.get(key) === created) this.entries.delete(key);
        }),
      );
      // Another acquire may have raced in while `create` was pending.
      entry = this.entries.get(key);
      if (entry) {
        await source.stop();
      } else {
        this.entries.set(key, created);
        entry = created;
        source.start();
      }
    }
    entry.refs++;
    const own = entry;
    const subs: Array<() => void> = [];
    let released = false;
    return {
      onFrame: (cb) => {
        subs.push(own.source.onFrame(cb));
      },
      onError: (cb) => {
        subs.push(own.source.onError(cb));
      },
      release: async () => {
        if (released) return;
        released = true;
        for (const off of subs) off();
        own.refs--;
        if (own.refs <= 0) {
          if (this.entries.get(key) === own) this.entries.delete(key);
          for (const off of own.unsubscribe) off();
          await own.source.stop();
        }
      },
    };
  }

  /** The newest frame a running camera produced, if it is running. */
  latest(spec: CameraSourceSpec): CameraFrame | null {
    return this.entries.get(cameraSourceKey(spec))?.latest ?? null;
  }

  isRunning(spec: CameraSourceSpec): boolean {
    return this.entries.has(cameraSourceKey(spec));
  }

  async stopAll(): Promise<void> {
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(
      all.map(async (e) => {
        for (const off of e.unsubscribe) off();
        await e.source.stop();
      }),
    );
  }
}
