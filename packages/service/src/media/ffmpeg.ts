/**
 * The system ffmpeg video and audio indexing decode with. Gezel ships no
 * media decoder of its own: `GEZEL_FFMPEG`, then `SQUISQ_FFMPEG` (the export
 * path's override), then `ffmpeg` on PATH, probed once with `-version`.
 * Without one, video and audio are simply not indexed, and Settings says so.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const PROBE_TIMEOUT_MS = 5_000;

export interface FfmpegInfo {
  path: string;
  version: string;
}

let probe: Promise<FfmpegInfo | null> | null = null;

function candidates(): string[] {
  const out: string[] = [];
  for (const name of ['GEZEL_FFMPEG', 'SQUISQ_FFMPEG'] as const) {
    const value = process.env[name]?.trim();
    if (value) out.push(value);
  }
  out.push(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  return out;
}

async function versionOf(path: string): Promise<string | null> {
  try {
    const { stdout } = await run(path, ['-hide_banner', '-version'], {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    const match = /ffmpeg version (\S+)/.exec(stdout);
    return match?.[1] ?? 'unknown';
  } catch {
    return null;
  }
}

/** The first working ffmpeg, cached for the process (see {@link resetFfmpegProbe}). */
export function locateFfmpeg(): Promise<FfmpegInfo | null> {
  probe ??= (async () => {
    for (const path of candidates()) {
      const version = await versionOf(path);
      if (version) return { path, version };
    }
    return null;
  })();
  return probe;
}

/** Forget the cached probe — after the user installs ffmpeg, say. */
export function resetFfmpegProbe(): void {
  probe = null;
}
