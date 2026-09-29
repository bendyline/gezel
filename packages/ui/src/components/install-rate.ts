/**
 * Download speed and time-left for a model install, from polled byte counts.
 *
 * Progress arrives in bursts — Hugging Face's chunked transfer reports whole
 * ~134 MB terms at a time — so an instantaneous rate swings between zero and
 * a spike. Averaging over a trailing window gives a steady figure, and
 * `lastMovedAt` lets the banner say "still downloading" during a quiet stretch
 * instead of looking frozen.
 */

export interface RateSample {
  at: number;
  bytes: number;
}

export interface InstallRate {
  samples: RateSample[];
  /** Bytes per second over the window; null until the window says something. */
  bytesPerSecond: number | null;
  /** When the byte count last increased. */
  lastMovedAt: number | null;
}

const WINDOW_MS = 60_000;
/** A rate over less time than this is noise. */
const MIN_SPAN_MS = 8_000;

export function emptyInstallRate(): InstallRate {
  return { samples: [], bytesPerSecond: null, lastMovedAt: null };
}

export function recordInstallSample(rate: InstallRate, at: number, bytes: number): InstallRate {
  const last = rate.samples.at(-1);
  // Fewer bytes than before is a restarted or different install.
  const base = last && bytes < last.bytes ? emptyInstallRate() : rate;
  const previous = base.samples.at(-1);
  const moved = !previous || bytes > previous.bytes;
  const samples = [...base.samples, { at, bytes }].filter((s) => at - s.at <= WINDOW_MS);
  const first = samples[0];
  const span = first ? at - first.at : 0;
  const gained = first ? bytes - first.bytes : 0;
  return {
    samples,
    bytesPerSecond: span >= MIN_SPAN_MS && gained > 0 ? gained / (span / 1000) : null,
    lastMovedAt: moved ? at : base.lastMovedAt,
  };
}

export function formatRate(bytesPerSecond: number): string {
  const mb = bytesPerSecond / 1024 ** 2;
  return mb >= 10 ? `${Math.round(mb)} MB/s` : `${mb.toFixed(1)} MB/s`;
}

export function formatTimeLeft(remainingBytes: number, bytesPerSecond: number): string {
  const seconds = remainingBytes / bytesPerSecond;
  if (seconds < 60) return 'less than a minute left';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round((minutes % 60) / 5) * 5;
  return rest === 0 || rest === 60
    ? `about ${rest === 60 ? hours + 1 : hours} h left`
    : `about ${hours} h ${rest} min left`;
}

/** Quiet long enough that the person should hear it is still working. */
export const QUIET_NOTICE_MS = 45_000;
/** Quiet long enough to suspect the connection. */
export const STALLED_NOTICE_MS = 180_000;

export type InstallQuiet = 'moving' | 'quiet' | 'stalled';

export function installQuiet(rate: InstallRate, now: number): InstallQuiet {
  if (rate.lastMovedAt === null) return 'moving';
  const quietFor = now - rate.lastMovedAt;
  if (quietFor >= STALLED_NOTICE_MS) return 'stalled';
  if (quietFor >= QUIET_NOTICE_MS) return 'quiet';
  return 'moving';
}
