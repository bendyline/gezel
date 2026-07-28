/**
 * UvRuntime — provisions Python virtualenvs for Gezel features that
 * need to run Python tools (MLX, future Whisper / STT engines, etc.).
 *
 * Detection order on first `ensureVenv`:
 *
 *   1. **Bundled uv** at `process.env.GEZEL_UV_BIN` — packaged Gezel
 *      owns the Python bootstrap and never invokes the macOS
 *      `/usr/bin/python3` developer-tools shim.
 *   2. **System `uv`** on PATH — development / bare-service fallback
 *      when no bundled binary is available. uv installs its own Python.
 *   3. **System `python3`** (or `python`) on PATH with version ≥
 *      `minPythonVersion` (default 3.10) — create the venv with
 *      stock `python -m venv` + pip. This is a last-resort fallback
 *      for non-packaged installs only.
 *
 * The selected source is recorded per-venv in `uv.json`; subsequent
 * `ensureVenv` calls for the same name with the same package list
 * reuse the existing venv without re-probing.
 *
 * Storage layout:
 *
 *   <home>/engines/uv/
 *   └── venvs/
 *       └── <name>/
 *           ├── uv.json                (this module's manifest)
 *           ├── bin/python | Scripts\python.exe
 *           └── lib/python3.x/...      (standard venv contents)
 *
 * Intentionally engine-agnostic — callers ask `ensureVenv('mlx',
 * ['mlx-lm==X'])` and get a `VenvHandle` with the Python binary path
 * and a `binPath(name)` helper for console scripts. How the venv got
 * there is hidden behind the `source` field for Settings to display.
 */

import { exec as nodeExec, spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from '@bendyline/gezel';

const log = createLogger('uv');

/** Source-of-truth for where the Python interpreter came from. */
export type UvRuntimeSource = 'system-uv' | 'system-python' | 'bundled-uv';

export interface VenvHandle {
  /** Venv name as passed to `ensureVenv` (and the directory basename). */
  name: string;
  /** Absolute path to the venv root directory. */
  venvRoot: string;
  /** Absolute path to the venv's `python` binary (correct per platform). */
  pythonPath: string;
  /** The installer route that provisioned this venv. */
  source: UvRuntimeSource;
  /** Python version inside the venv, e.g. '3.11.7'. */
  pythonVersion: string;
  /** uv version that created this venv (only when `source` used uv). */
  uvVersion?: string;
  /** Packages requested at install/ensure time. */
  packages: string[];
  /** ISO timestamp of the last install (create or package refresh). */
  installedAt: string;
  /**
   * Resolve the path to a console script installed into this venv
   * (e.g. `binPath('mlx_lm.server')`). Handles the bin/ vs Scripts/
   * split and the `.exe` suffix on Windows. Does not check that the
   * script exists — callers that care should `existsSync` the result.
   */
  binPath(name: string): string;
}

export interface EnsureVenvOptions {
  /** Short identifier used as the venv directory name. Must match `/^[a-z0-9][a-z0-9._-]{0,63}$/i`. */
  name: string;
  /**
   * Pip-style package specs — ideally pinned (`mlx-lm==0.25.3`) for
   * reproducibility. Unpinned specs are allowed but log a warning.
   */
  packages: string[];
  /**
   * Minimum acceptable Python version as `major.minor`. Default `3.10`.
   * Checked against both system Python (for the system-python branch)
   * and the venv's Python (reported after creation).
   */
  minPythonVersion?: string;
  /**
   * Exact Python version to request from uv (the `--python` flag) when
   * uv is the installer. Ignored on the system-python branch —
   * there's no way to tell `python -m venv` to download a different
   * version. Default `3.11`.
   */
  preferredPythonVersion?: string;
  /**
   * Replace the primary package index (the `--index-url` flag). Rarely
   * needed — prefer {@link extraIndexUrls} so PyPI stays the default.
   */
  indexUrl?: string;
  /**
   * Additional package indexes searched alongside PyPI (one
   * `--extra-index-url` per entry). The video engine uses this to pull
   * the platform-matched PyTorch CUDA wheel from
   * `https://download.pytorch.org/whl/cu124` while keeping PyPI primary
   * for `diffusers`/`transformers`/etc. Folded into the manifest
   * fast-path key so switching accelerators (cpu → cuda) reinstalls
   * instead of silently reusing the wrong torch build.
   */
  extraIndexUrls?: string[];
}

export interface UvRuntimeOptions {
  /** GEZEL_HOME — venvs land under `<home>/engines/uv/venvs/`. */
  home: string;
  /**
   * Override the bundled-uv binary path lookup. Real code reads
   * `process.env.GEZEL_UV_BIN`; tests can inject without touching env.
   * Pass `null` to disable bundled-uv fallback entirely.
   */
  bundledUvBin?: string | null;
  /** Test seam — defaults to node's `child_process.spawn`. */
  spawn?: typeof nodeSpawn;
  /** Test seam — defaults to node's `child_process.exec`. */
  exec?: typeof nodeExec;
  onLog?: (line: string) => void;
}

const DEFAULT_MIN_PY = '3.10';
const DEFAULT_PREFERRED_PY = '3.11';

export class UvRuntime {
  private readonly home: string;
  private readonly venvsRoot: string;
  private readonly bundledUvBinOverride: string | null;
  private readonly readBundledUvFromEnv: boolean;
  private readonly spawn: typeof nodeSpawn;
  private readonly exec: (
    cmd: string,
    opts?: { timeout?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  private readonly onLog: (line: string) => void;
  /** Cached probe result so repeated `ensureVenv` calls skip the re-probe. */
  private probed: {
    source: UvRuntimeSource;
    installerPath: string;
    uvVersion?: string;
    pythonVersion?: string;
  } | null = null;
  /**
   * Per-venv-name serialization tail. The MLX venv is now provisioned
   * by two concurrent callers — the parallel warm fired when a model
   * install starts, and the lazy first-chat `ensureVenv` — and on a
   * cold machine both can miss the manifest fast-path and call
   * `createVenv()`, which `rm -rf`s the venv dir. Two of those racing
   * clobber each other's install. We chain same-name calls so the
   * second observes the first's finished venv via the fast-path
   * instead of rebuilding it.
   */
  private readonly venvLocks = new Map<string, Promise<void>>();

  constructor(opts: UvRuntimeOptions) {
    this.home = opts.home;
    this.venvsRoot = join(opts.home, 'engines', 'uv', 'venvs');
    this.readBundledUvFromEnv = opts.bundledUvBin === undefined;
    this.bundledUvBinOverride = opts.bundledUvBin ?? null;
    this.spawn = opts.spawn ?? nodeSpawn;
    const execFn = opts.exec ?? nodeExec;
    this.exec = promisify(execFn) as typeof this.exec;
    this.onLog = opts.onLog ?? ((line) => log.info(line));
  }

  /**
   * Idempotent: return a handle to the named venv with the requested
   * packages installed. Creates the venv if missing; installs/upgrades
   * packages when the recorded set differs from the request.
   */
  async ensureVenv(opts: EnsureVenvOptions): Promise<VenvHandle> {
    if (!isSafeVenvName(opts.name)) {
      throw new Error(`unsafe venv name: ${opts.name}`);
    }
    // Serialize per-name so a background warm and the lazy first-chat
    // call for the same venv don't both run createVenv() concurrently
    // (see `venvLocks`). The second caller, chained after the first,
    // hits the manifest fast-path and returns the already-built venv.
    const tail = this.venvLocks.get(opts.name) ?? Promise.resolve();
    const result = tail.then(
      () => this.ensureVenvSerial(opts),
      () => this.ensureVenvSerial(opts),
    );
    // Store a non-rejecting guard as the new tail so a failed install
    // doesn't poison the chain for the next caller.
    this.venvLocks.set(
      opts.name,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  private async ensureVenvSerial(opts: EnsureVenvOptions): Promise<VenvHandle> {
    const minPy = opts.minPythonVersion ?? DEFAULT_MIN_PY;
    const preferredPy = opts.preferredPythonVersion ?? DEFAULT_PREFERRED_PY;
    const packages = [...opts.packages].sort();
    const indexConfig: IndexConfig = {
      ...(opts.indexUrl ? { indexUrl: opts.indexUrl } : {}),
      ...(opts.extraIndexUrls && opts.extraIndexUrls.length > 0
        ? { extraIndexUrls: [...opts.extraIndexUrls].sort() }
        : {}),
    };

    const venvRoot = join(this.venvsRoot, opts.name);
    const manifestPath = join(venvRoot, 'uv.json');
    const pythonPath = venvPythonPath(venvRoot);

    const existing = await readManifest(manifestPath);
    if (
      existing &&
      existsSync(pythonPath) &&
      packageListsEqual(existing.packages, packages) &&
      indexConfigEqual(existing, indexConfig)
    ) {
      return toHandle(existing, venvRoot);
    }

    const probe = await this.resolveInstaller(minPy);
    await mkdir(this.venvsRoot, { recursive: true });

    if (!existsSync(pythonPath)) {
      await this.createVenv(probe, venvRoot, preferredPy);
    }
    if (packages.length > 0) {
      await this.installPackages(probe, venvRoot, packages, indexConfig);
    }

    const pythonVersion = await this.readPythonVersion(venvPythonPath(venvRoot));
    const now = new Date().toISOString();
    const manifest: StoredManifest = {
      version: 1,
      name: opts.name,
      source: probe.source,
      pythonVersion,
      ...(probe.uvVersion ? { uvVersion: probe.uvVersion } : {}),
      packages,
      ...(indexConfig.indexUrl ? { indexUrl: indexConfig.indexUrl } : {}),
      ...(indexConfig.extraIndexUrls ? { extraIndexUrls: indexConfig.extraIndexUrls } : {}),
      installedAt: now,
      installerPath: probe.installerPath,
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    return toHandle(manifest, venvRoot);
  }

  /** Delete a venv entirely. No-op when it doesn't exist. */
  async removeVenv(name: string): Promise<void> {
    if (!isSafeVenvName(name)) {
      throw new Error(`unsafe venv name: ${name}`);
    }
    await rm(join(this.venvsRoot, name), { recursive: true, force: true });
  }

  /** List every venv with a valid manifest under `venvs/`. Sorted by name. */
  async listVenvs(): Promise<VenvHandle[]> {
    let entries: string[] = [];
    try {
      entries = await readdir(this.venvsRoot);
    } catch {
      return [];
    }
    const out: VenvHandle[] = [];
    for (const name of entries.sort()) {
      const manifest = await readManifest(join(this.venvsRoot, name, 'uv.json'));
      if (manifest) {
        out.push(toHandle(manifest, join(this.venvsRoot, name)));
      }
    }
    return out;
  }

  /**
   * Report on the current runtime without creating a venv — powers the
   * Settings "Python runtime" status block.
   *   - `source`: `null` when no suitable runtime exists on this host.
   *   - `pythonVersion`: the interpreter version we'd use (system Python
   *     or uv-managed; empty string for uv when no venv created yet).
   */
  async describeRuntime(minPythonVersion = DEFAULT_MIN_PY): Promise<{
    source: UvRuntimeSource | null;
    installerPath?: string;
    uvVersion?: string;
    pythonVersion?: string;
    bundledUvAvailable: boolean;
    reason?: string;
  }> {
    const bundledUvBin = this.resolveBundledUvBin();
    const bundledUvAvailable = bundledUvBin != null && existsSync(bundledUvBin);
    try {
      const probe = await this.resolveInstaller(minPythonVersion);
      const out: Awaited<ReturnType<UvRuntime['describeRuntime']>> = {
        source: probe.source,
        installerPath: probe.installerPath,
        bundledUvAvailable,
      };
      if (probe.uvVersion) out.uvVersion = probe.uvVersion;
      if (probe.pythonVersion) out.pythonVersion = probe.pythonVersion;
      return out;
    } catch (err) {
      return {
        source: null,
        bundledUvAvailable,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async resolveInstaller(minPy: string): Promise<ProbedInstaller> {
    const bundledUvBin = this.resolveBundledUvBin();
    // A runtime download can stamp GEZEL_UV_BIN after this manager was
    // constructed (the CLI first-run bootstrap does exactly that). Prefer the
    // newly available pinned binary even if an earlier call cached a system
    // fallback, so the same daemon can continue without a restart.
    if (bundledUvBin && existsSync(bundledUvBin) && this.probed?.installerPath !== bundledUvBin) {
      this.probed = null;
    }
    if (this.probed) return this.probed;

    // ── 1. Bundled uv ────────────────────────────────────────────
    // Packaged builds always take this branch. In particular, do not
    // probe `python3` first on macOS: Apple's stub opens the intrusive
    // "install Command Line Developer Tools" dialog just to answer
    // `--version`, even though Gezel already ships everything needed to
    // provision an isolated Python under GEZEL_HOME.
    if (bundledUvBin && existsSync(bundledUvBin)) {
      const version = await this.probeCommandVersion(
        `"${bundledUvBin}" --version`,
        /uv\s+(\d[\w.+-]*)/i,
      );
      this.probed = {
        source: 'bundled-uv',
        installerPath: bundledUvBin,
        ...(version ? { uvVersion: version } : {}),
      };
      this.onLog(`[uv-runtime] using bundled uv ${version ?? '?'} at ${bundledUvBin}`);
      return this.probed;
    }

    // ── 2. System uv on PATH ──────────────────────────────────────
    const sysUv = await this.probeCommandVersion('uv --version', /uv\s+(\d[\w.+-]*)/i);
    if (sysUv) {
      this.probed = {
        source: 'system-uv',
        installerPath: 'uv',
        uvVersion: sysUv,
      };
      this.onLog(`[uv-runtime] using system uv ${sysUv}`);
      return this.probed;
    }

    // ── 3. System Python ≥ minPy ─────────────────────────────────
    for (const candidate of systemPythonCandidates()) {
      const version = await this.probeCommandVersion(
        `${candidate} --version`,
        /Python\s+(\d+\.\d+(?:\.\d+)?)/i,
      );
      if (version && versionGte(version, minPy)) {
        this.probed = {
          source: 'system-python',
          installerPath: candidate,
          pythonVersion: version,
        };
        this.onLog(`[uv-runtime] using system Python ${version} (${candidate})`);
        return this.probed;
      }
    }

    const err = new Error(
      'Python runtime unavailable. Packaged Gezel should include its own managed runtime; reinstall Gezel, or install uv / Python 3.11 when running gezeld from source.',
    );
    (err as Error & { isActionable: boolean }).isActionable = true;
    throw err;
  }

  private resolveBundledUvBin(): string | null {
    return this.readBundledUvFromEnv
      ? (process.env.GEZEL_UV_BIN ?? null)
      : this.bundledUvBinOverride;
  }

  private async createVenv(
    probe: ProbedInstaller,
    venvRoot: string,
    preferredPy: string,
  ): Promise<void> {
    await rm(venvRoot, { recursive: true, force: true });
    if (probe.source === 'system-python') {
      await this.run(probe.installerPath, ['-m', 'venv', venvRoot]);
      return;
    }
    // uv path (system or bundled) — uv picks/downloads Python itself.
    await this.run(probe.installerPath, ['venv', '--python', preferredPy, venvRoot]);
  }

  private async installPackages(
    probe: ProbedInstaller,
    venvRoot: string,
    packages: string[],
    indexConfig: IndexConfig = {},
  ): Promise<void> {
    const pythonPath = venvPythonPath(venvRoot);
    const indexArgs = indexInstallArgs(indexConfig);
    if (probe.source === 'system-python') {
      // Use the venv's own pip, pinned against its python.
      await this.run(pythonPath, [
        '-m',
        'pip',
        'install',
        '--disable-pip-version-check',
        ...indexArgs,
        ...packages,
      ]);
      return;
    }
    await this.run(probe.installerPath, [
      'pip',
      'install',
      '--python',
      pythonPath,
      ...indexArgs,
      ...packages,
    ]);
  }

  private async readPythonVersion(pythonPath: string): Promise<string> {
    const out = await this.exec(`"${pythonPath}" --version`).catch(() => ({
      stdout: '',
      stderr: '',
    }));
    const m = `${out.stdout}\n${out.stderr}`.match(/Python\s+(\d+\.\d+(?:\.\d+)?)/i);
    return m?.[1] ?? '';
  }

  private async probeCommandVersion(cmd: string, pattern: RegExp): Promise<string | undefined> {
    try {
      const { stdout, stderr } = await this.exec(cmd, { timeout: 5_000 });
      const m = `${stdout}\n${stderr}`.match(pattern);
      return m?.[1];
    } catch {
      return undefined;
    }
  }

  /**
   * Run a command inheriting env + piping output through onLog.
   * Rejects on non-zero exit. Uses the injected `spawn` so tests can
   * drive the lifecycle without real subprocesses.
   */
  private run(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.spawn(command, args, {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // Keep a ring buffer of the most recent meaningful (non-noise)
      // lines so a non-zero exit can surface WHY it failed (e.g.
      // "ERROR: Could not find a version that satisfies torch==2.5.1")
      // instead of a bare "exited with code 1" that gives the user
      // nothing actionable.
      const recent: string[] = [];
      const remember = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        recent.push(trimmed);
        if (recent.length > 12) recent.shift();
      };
      const emit = (line: string) => {
        if (!line) return;
        remember(line);
        if (isPipNoiseLine(line)) return;
        this.onLog(`[uv-runtime] ${line}`);
      };
      child.stdout?.on('data', (buf: Buffer) => {
        for (const line of buf.toString().split('\n')) emit(line);
      });
      child.stderr?.on('data', (buf: Buffer) => {
        for (const line of buf.toString().split('\n')) emit(line);
      });
      child.on('error', (err) => reject(err));
      child.on('exit', (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        // Prefer the actual error lines (pip prints `ERROR:` / `error:`)
        // over the whole tail, falling back to the last few lines.
        const errLines = recent.filter((l) => /^(error|ERROR|×|error:)/.test(l));
        const detail = (errLines.length > 0 ? errLines : recent.slice(-4)).join(' | ');
        reject(
          new Error(
            `${command} ${args.join(' ')} exited with code ${code}${detail ? `: ${detail}` : ''}`,
          ),
        );
      });
    });
  }
}

/**
 * Pip emits one line per transitive dep when it's already installed
 * ("Requirement already satisfied: …") and one per wheel pulled from
 * the local cache ("Using cached …"). Both are noise on a healthy
 * install — failures surface through "ERROR:", "Could not find", and
 * stderr tracebacks, none of which match these prefixes.
 */
function isPipNoiseLine(line: string): boolean {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('Requirement already satisfied:')) return true;
  if (trimmed.startsWith('Using cached ')) return true;
  return false;
}

interface ProbedInstaller {
  source: UvRuntimeSource;
  installerPath: string;
  uvVersion?: string;
  pythonVersion?: string;
}

/** Normalized package-index overrides; `extraIndexUrls` is pre-sorted. */
interface IndexConfig {
  indexUrl?: string;
  extraIndexUrls?: string[];
}

/**
 * Build the `--index-url` / `--extra-index-url` flags shared by both
 * the pip and uv install branches (both accept the same flag names).
 */
function indexInstallArgs(cfg: IndexConfig): string[] {
  const args: string[] = [];
  if (cfg.indexUrl) args.push('--index-url', cfg.indexUrl);
  for (const url of cfg.extraIndexUrls ?? []) args.push('--extra-index-url', url);
  return args;
}

/** Manifest fast-path: the recorded index config must match the request. */
function indexConfigEqual(a: IndexConfig, b: IndexConfig): boolean {
  if ((a.indexUrl ?? '') !== (b.indexUrl ?? '')) return false;
  const ax = a.extraIndexUrls ?? [];
  const bx = b.extraIndexUrls ?? [];
  if (ax.length !== bx.length) return false;
  return ax.every((v, i) => v === bx[i]);
}

interface StoredManifest {
  version: 1;
  name: string;
  source: UvRuntimeSource;
  pythonVersion: string;
  uvVersion?: string;
  packages: string[];
  indexUrl?: string;
  extraIndexUrls?: string[];
  installedAt: string;
  installerPath: string;
}

async function readManifest(path: string): Promise<StoredManifest | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: Partial<StoredManifest>;
  try {
    parsed = JSON.parse(raw) as Partial<StoredManifest>;
  } catch {
    return null;
  }
  if (
    parsed.version !== 1 ||
    typeof parsed.name !== 'string' ||
    typeof parsed.source !== 'string' ||
    typeof parsed.pythonVersion !== 'string' ||
    !Array.isArray(parsed.packages)
  ) {
    return null;
  }
  return parsed as StoredManifest;
}

function toHandle(manifest: StoredManifest, venvRoot: string): VenvHandle {
  return {
    name: manifest.name,
    venvRoot,
    pythonPath: venvPythonPath(venvRoot),
    source: manifest.source,
    pythonVersion: manifest.pythonVersion,
    ...(manifest.uvVersion ? { uvVersion: manifest.uvVersion } : {}),
    packages: manifest.packages,
    installedAt: manifest.installedAt,
    binPath: (scriptName) => venvBinPath(venvRoot, scriptName),
  };
}

function venvPythonPath(venvRoot: string): string {
  return process.platform === 'win32'
    ? join(venvRoot, 'Scripts', 'python.exe')
    : join(venvRoot, 'bin', 'python');
}

function venvBinPath(venvRoot: string, scriptName: string): string {
  if (process.platform === 'win32') {
    const name = scriptName.endsWith('.exe') ? scriptName : `${scriptName}.exe`;
    return join(venvRoot, 'Scripts', name);
  }
  return join(venvRoot, 'bin', scriptName);
}

function systemPythonCandidates(): string[] {
  if (process.platform === 'win32') {
    return ['python', 'py -3'];
  }
  return ['python3', 'python'];
}

function packageListsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}

function isSafeVenvName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name);
}

export function versionGte(actual: string, minimum: string): boolean {
  const a = actual.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const m = minimum.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, m.length); i++) {
    const av = a[i] ?? 0;
    const mv = m[i] ?? 0;
    if (av > mv) return true;
    if (av < mv) return false;
  }
  return true;
}
