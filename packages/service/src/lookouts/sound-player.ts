/**
 * Plays a short sound on this computer's speakers for a lookout — the chime
 * that says "the cat is on the floor" while it is still on the floor. The
 * product daemon runs in the person's session (per-user process, Electron
 * utility process, or in the app), so the OS's own player works with every
 * window closed.
 *
 * The three clips are synthesized here rather than shipped as assets: a few
 * lines of arithmetic, no files to bundle or license, and a cache under
 * `~/.gezel/lookouts/sounds/` regenerated whenever it is missing.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LookoutSoundClip } from '@bendyline/gezel';
import { createLogger } from '@bendyline/gezel';
import { writeFileAtomic } from '@bendyline/gezel-inference/internal/fs/atomic';

const log = createLogger('lookouts');

const SAMPLE_RATE = 22_050;
/** Bumping it regenerates the cached clips after a change to the synthesis. */
const CLIP_VERSION = 1;
const MAX_PLAY_MS = 12_000;

/** A 16-bit mono PCM WAV from samples in [-1, 1]. */
export function encodeWav(samples: Float32Array, sampleRate = SAMPLE_RATE): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] as number));
    data.writeInt16LE(Math.round(v * 32_767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function tone(
  out: Float32Array,
  startS: number,
  durS: number,
  freq: (t: number) => number,
  opts: { gain?: number; decay?: number; harmonics?: number[] } = {},
): void {
  const start = Math.floor(startS * SAMPLE_RATE);
  const n = Math.floor(durS * SAMPLE_RATE);
  const gain = opts.gain ?? 0.5;
  const harmonics = opts.harmonics ?? [1];
  let phase = 0;
  for (let i = 0; i < n && start + i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    phase += (2 * Math.PI * freq(t)) / SAMPLE_RATE;
    // 8 ms attack and release keep every edge click-free.
    const edge = Math.min(1, t / 0.008, (durS - t) / 0.008);
    const env = edge * (opts.decay ? Math.exp(-t * opts.decay) : 1);
    let v = 0;
    harmonics.forEach((h, k) => {
      v += Math.sin(phase * h) / (k + 1);
    });
    out[start + i] = (out[start + i] as number) + v * env * gain;
  }
}

/** The samples for a clip. Deterministic. */
export function synthesizeClip(clip: LookoutSoundClip): Float32Array {
  if (clip === 'chime') {
    const out = new Float32Array(Math.floor(1.6 * SAMPLE_RATE));
    tone(out, 0, 1.0, () => 988, { gain: 0.35, decay: 3.5, harmonics: [1, 2.76] });
    tone(out, 0.22, 1.3, () => 1319, { gain: 0.35, decay: 3, harmonics: [1, 2.76] });
    return out;
  }
  if (clip === 'alarm') {
    // Two-tone, like a smoke alarm's chirp: hard to sleep through, and a
    // sound most cats would rather leave than hear twice.
    const out = new Float32Array(Math.floor(3.0 * SAMPLE_RATE));
    for (let k = 0; k < 6; k++) {
      tone(out, k * 0.5, 0.24, () => (k % 2 === 0 ? 2_900 : 2_300), {
        gain: 0.45,
        harmonics: [1, 3],
      });
    }
    return out;
  }
  const out = new Float32Array(Math.floor(1.4 * SAMPLE_RATE));
  tone(out, 0, 0.45, (t) => 1_200 + t * 3_000, { gain: 0.5 });
  tone(out, 0.6, 0.6, (t) => 2_600 - t * 2_000, { gain: 0.5 });
  return out;
}

export interface SoundPlayerOptions {
  home: string;
  platform?: NodeJS.Platform;
  spawnImpl?: typeof spawn;
  /** `record` plays nothing and remembers what it would have played (tests, E2E). */
  mode?: 'play' | 'record';
}

export class SoundPlayer {
  /** What a recording player was asked to play, oldest first. */
  readonly played: string[] = [];
  private readonly children = new Set<ChildProcess>();
  private readonly platform: NodeJS.Platform;
  private readonly mode: 'play' | 'record';

  constructor(private readonly opts: SoundPlayerOptions) {
    this.platform = opts.platform ?? process.platform;
    this.mode = opts.mode ?? (process.env.GEZEL_SOUND_PLAYER === 'record' ? 'record' : 'play');
  }

  /** The clip's WAV on disk, written on first use. */
  async clipPath(clip: LookoutSoundClip): Promise<string> {
    const dir = join(this.opts.home, 'lookouts', 'sounds');
    const path = join(dir, `${clip}-v${CLIP_VERSION}.wav`);
    try {
      await access(path);
    } catch {
      await mkdir(dir, { recursive: true });
      await writeFileAtomic(path, encodeWav(synthesizeClip(clip)));
    }
    return path;
  }

  async playClip(clip: LookoutSoundClip): Promise<void> {
    if (this.mode === 'record') {
      this.played.push(clip);
      return;
    }
    await this.playFile(await this.clipPath(clip));
  }

  /** Play a WAV file; resolves when it ends (or after the playback cap). */
  async playFile(path: string, label = path): Promise<void> {
    if (this.mode === 'record') {
      this.played.push(label);
      return;
    }
    const candidates = this.commands(path);
    let lastError: unknown = null;
    for (const [cmd, args, env] of candidates) {
      try {
        await this.run(cmd, args, env);
        return;
      } catch (err) {
        lastError = err;
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') break;
      }
    }
    throw new Error(
      `could not play a sound on this computer${lastError instanceof Error ? `: ${lastError.message}` : ''}`,
    );
  }

  private commands(path: string): Array<[string, string[], NodeJS.ProcessEnv | undefined]> {
    if (this.platform === 'win32') {
      // The path rides in the environment, never in the command text.
      return [
        [
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            '(New-Object System.Media.SoundPlayer $env:GEZEL_SOUND_PATH).PlaySync()',
          ],
          { ...process.env, GEZEL_SOUND_PATH: path },
        ],
      ];
    }
    if (this.platform === 'darwin') return [['afplay', [path], undefined]];
    return [
      ['pw-play', [path], undefined],
      ['paplay', [path], undefined],
      ['aplay', ['-q', path], undefined],
    ];
  }

  private run(cmd: string, args: string[], env: NodeJS.ProcessEnv | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = (this.opts.spawnImpl ?? spawn)(cmd, args, {
        stdio: 'ignore',
        windowsHide: true,
        ...(env ? { env } : {}),
      });
      this.children.add(child);
      const timer = setTimeout(() => child.kill(), MAX_PLAY_MS);
      timer.unref?.();
      child.once('error', (err) => {
        clearTimeout(timer);
        this.children.delete(child);
        reject(err);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        this.children.delete(child);
        if (code === 0 || code === null) resolve();
        else reject(new Error(`${cmd} exited with ${code}`));
      });
    });
  }

  /** Stop whatever is playing (the alert's Stop key, emergency stop). */
  stopAll(): number {
    let n = 0;
    for (const child of this.children) {
      child.kill();
      n++;
    }
    this.children.clear();
    if (n > 0) log.info(`stopped ${n} playing sound(s)`);
    return n;
  }
}
