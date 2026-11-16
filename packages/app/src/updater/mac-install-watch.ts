/**
 * Noticing that a macOS update has finished installing.
 *
 * The update flow hands a verified PKG to Installer.app (see mac-pkg.ts) and
 * used to hear nothing back: the package replaced the bundle and restarted
 * the machine service underneath a running app whose button still read
 * "Opening installer…". Two facts make "finished" observable without any
 * privileged code:
 *
 *   - PackageKit writes the package receipt only after the postinstall has
 *     returned, and writes none when the install fails. install.log shows the
 *     order: `Executing script "postinstall"` … `GezelService installed and
 *     started.` … `Writing receipt for com.bendyline.gezel`. A receipt whose
 *     `install-time` is at or after the moment we started waiting therefore
 *     means the whole install is done: payload, LaunchDaemon, service tree.
 *   - The running bundle's Info.plist matched the running version at launch,
 *     so a different CFBundleShortVersionString on disk means the bundle was
 *     replaced underneath us, and a relaunch runs the new release.
 *
 * Neither is enough alone. The receipt's `version` is always 0 for this
 * package, and a reinstall of the same release moves its time too. The
 * payload lands before the postinstall runs, so relaunching on the version
 * alone would race the service-tree extraction and the LaunchDaemon restart.
 */
import { basename, dirname, join } from 'node:path';
import type { ExecFileFn } from './mac-pkg.js';

/** `pkg.identifier` defaults to the electron-builder `appId`. */
export const MAC_PKG_IDENTIFIER = 'com.bendyline.gezel';

const POLL_INTERVAL_MS = 2_000;
const FOCUS_THROTTLE_MS = 15_000;
/** `open` that cannot open the file exits within a few hundred milliseconds. */
const OPEN_SETTLE_MS = 1_500;
const STDERR_LIMIT = 4_096;

/** `pkgutil --pkg-info` prints `install-time: <unix seconds>`. */
export function parsePkgInstallTime(stdout: string): number | null {
  const match = /^install-time:\s*(\d+)\s*$/m.exec(stdout);
  if (!match?.[1]) return null;
  const seconds = Number(match[1]);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

/** `/Applications/Gezel.app/Contents/MacOS/Gezel` → `/Applications/Gezel.app`. */
export function macAppBundlePath(execPath: string): string | null {
  const macOSDir = dirname(execPath);
  const contentsDir = dirname(macOSDir);
  const bundle = dirname(contentsDir);
  if (basename(macOSDir) !== 'MacOS' || basename(contentsDir) !== 'Contents') return null;
  return bundle.endsWith('.app') ? bundle : null;
}

export interface InstalledUpdateProbe {
  bundlePath: string;
  runningVersion: string;
  /** Unix seconds; a receipt older than this belongs to an earlier install. */
  sinceEpochSeconds: number;
}

/**
 * The version a finished install put on disk, or null while there is none.
 * Reads the bundle first: it is the cheap check, and the usual answer is
 * "unchanged", which never needs pkgutil.
 */
export async function probeInstalledMacUpdate(
  probe: InstalledUpdateProbe,
  deps: { execFile: ExecFileFn },
): Promise<{ version: string } | null> {
  const onDisk = await readBundleVersion(probe.bundlePath, deps.execFile);
  if (!onDisk || onDisk === probe.runningVersion) return null;
  const installTime = await readReceiptInstallTime(deps.execFile);
  if (installTime === null || installTime < probe.sinceEpochSeconds) return null;
  return { version: onDisk };
}

async function readBundleVersion(bundlePath: string, execFile: ExecFileFn): Promise<string | null> {
  try {
    // plutil reads XML and binary plists alike. A read that lands while
    // PackageKit is replacing the file fails; the next probe tries again.
    const { stdout } = await execFile('/usr/bin/plutil', [
      '-extract',
      'CFBundleShortVersionString',
      'raw',
      '-o',
      '-',
      join(bundlePath, 'Contents', 'Info.plist'),
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function readReceiptInstallTime(execFile: ExecFileFn): Promise<number | null> {
  try {
    const { stdout } = await execFile('/usr/sbin/pkgutil', ['--pkg-info', MAC_PKG_IDENTIFIER]);
    return parsePkgInstallTime(stdout);
  } catch {
    // pkgutil exits 1 when there is no receipt at all.
    return null;
  }
}

export interface MacInstallWatchOptions {
  probe: (sinceEpochSeconds: number) => Promise<{ version: string } | null>;
  /**
   * Called once, with `fromHandoff` true when the install is the one this app
   * opened Installer.app for, and false when someone ran a package by hand.
   */
  onInstalled: (found: { version: string; fromHandoff: boolean }) => void;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  pollIntervalMs?: number;
  focusThrottleMs?: number;
}

/**
 * Polls while Installer.app has our package open, and checks on window focus
 * for a package someone ran themselves (the install-failed notice tells them
 * to). Nothing runs between those: no idle timer.
 */
export class MacInstallWatch {
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly startedAtSeconds: number;
  private handoffSince: number | null = null;
  private timer: unknown = null;
  private probing: Promise<boolean> | null = null;
  private lastFocusProbeAt = Number.NEGATIVE_INFINITY;
  private found = false;

  constructor(private readonly opts: MacInstallWatchOptions) {
    this.now = opts.now ?? Date.now;
    this.schedule = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = opts.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.startedAtSeconds = this.nowSeconds();
  }

  get installed(): boolean {
    return this.found;
  }

  /** Call just before opening the installer, so `since` precedes its receipt. */
  startHandoff(): void {
    if (this.found) return;
    // Opening it again keeps the first start: the install may already be running.
    this.handoffSince ??= this.nowSeconds();
    if (this.timer === null) this.scheduleTick();
  }

  /** The installer could not be opened after all. */
  cancelHandoff(): void {
    this.handoffSince = null;
    this.clearTimer();
  }

  /** Installer.app quit. Resolves to whether the install it ran finished. */
  async installerClosed(): Promise<boolean> {
    this.clearTimer();
    if (this.found) return true;
    if (this.handoffSince === null) return false;
    const since = this.handoffSince;
    const finished = await this.runProbe(since, true);
    if (!finished) this.handoffSince = null;
    return finished;
  }

  /** A window took focus: catch a package run outside the update flow. */
  async focused(): Promise<void> {
    if (this.found || this.handoffSince !== null) return;
    const at = this.now();
    if (at - this.lastFocusProbeAt < (this.opts.focusThrottleMs ?? FOCUS_THROTTLE_MS)) return;
    this.lastFocusProbeAt = at;
    await this.runProbe(this.startedAtSeconds, false);
  }

  stop(): void {
    this.handoffSince = null;
    this.clearTimer();
  }

  private scheduleTick(): void {
    this.timer = this.schedule(() => {
      this.timer = null;
      const since = this.handoffSince;
      if (since === null || this.found) return;
      void this.runProbe(since, true).then((finished) => {
        if (!finished && this.handoffSince !== null && this.timer === null) this.scheduleTick();
      });
    }, this.opts.pollIntervalMs ?? POLL_INTERVAL_MS);
  }

  private runProbe(since: number, fromHandoff: boolean): Promise<boolean> {
    // One probe at a time; a caller arriving mid-probe shares its answer.
    this.probing ??= this.opts
      .probe(since)
      .catch(() => null)
      .then((result) => {
        this.probing = null;
        if (!result || this.found) return this.found;
        this.found = true;
        this.clearTimer();
        this.opts.onInstalled({ version: result.version, fromHandoff });
        return true;
      });
    return this.probing;
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.cancel(this.timer);
    this.timer = null;
  }

  private nowSeconds(): number {
    return Math.floor(this.now() / 1000);
  }
}

export interface InstallerChild {
  once(event: 'exit', listener: (code: number | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  stderr?: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null;
}

export type OpenInstallerResult =
  | { ok: true; closed: Promise<void> }
  | { ok: false; error: string };

/**
 * Open the package with `open -W`, which stays alive until Installer.app
 * quits. That exit is how Gezel learns a person closed the installer without
 * finishing, so the button can go back to "Open installer". `open` exits at
 * once with a non-zero status when it cannot open the file; still running
 * after a moment means Installer.app has it.
 */
export function openInstallerAndWait(
  pkgPath: string,
  deps: {
    spawn: (command: string, args: string[]) => InstallerChild;
    setTimeout?: (fn: () => void, ms: number) => unknown;
    settleMs?: number;
  },
): Promise<OpenInstallerResult> {
  const schedule = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  return new Promise((resolve) => {
    let child: InstallerChild;
    try {
      child = deps.spawn('/usr/bin/open', ['-W', pkgPath]);
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < STDERR_LIMIT) stderr += String(chunk);
    });
    let settled = false;
    const settle = (result: OpenInstallerResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const closed = new Promise<void>((done) => {
      child.once('exit', (code) => {
        done();
        settle(
          code === 0
            ? { ok: true, closed: Promise.resolve() }
            : { ok: false, error: stderr.trim() || `open exited with status ${code}` },
        );
      });
      child.once('error', (err) => {
        done();
        settle({ ok: false, error: err.message });
      });
    });
    schedule(() => settle({ ok: true, closed }), deps.settleMs ?? OPEN_SETTLE_MS);
  });
}
