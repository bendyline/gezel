import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Walk up from this file to find the repo root (the directory containing
 * `pnpm-workspace.yaml`). Robust to ever moving the evals package.
 */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('could not locate repo root');
}

const LLAMA_BACKEND_PRECEDENCE = ['cuda', 'vulkan', 'metal', 'cpu'] as const;
export type LlamaBackend = (typeof LLAMA_BACKEND_PRECEDENCE)[number];

export interface ResolvedBinary {
  path: string;
  variant: string | null;
}

function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

/**
 * Candidate on-disk filenames for a logical engine binary, most-preferred
 * first. Build scripts now emit a `gezel-` prefixed binary (the process shows
 * as `gezel-llama-server` in Task Manager / GPU listings — Gezel attribution,
 * upstream lineage kept in the suffix). The bare upstream name is retained as
 * a fallback so binaries fetched or built BEFORE the rename still resolve.
 */
function exeCandidates(binaryName: string): string[] {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return [`gezel-${binaryName}${ext}`, `${binaryName}${ext}`];
}

/**
 * Lookup roots in priority order:
 *   1. `<repo>/packages/app/native-bin/` (release-electron CI populates this).
 *   2. `<repo>/native/build/` (dev-local engine builds land here).
 *
 * Mirrors `packages/app/src/supervisor/native-bin.ts` precedence + variant
 * fallback, without importing Electron deps.
 */
function lookupRoots(): string[] {
  const root = repoRoot();
  return [join(root, 'packages', 'app', 'native-bin'), join(root, 'native', 'build')];
}

/**
 * Fallback roots that point at an *installed* Gezel desktop app's bundled
 * engines. Used when neither the CI nor dev-build roots are populated — the
 * common case on a dev machine (notably an Apple Silicon Mac) that runs the
 * packaged app but has never built llama.cpp locally. Before this fallback,
 * `pnpm eval:run … --provider llama-cpp` there required an explicit
 * `--llama-bin` pointing into the app bundle.
 *
 * The packaged app ships binaries under
 * `…/Gezel.app/Contents/Resources/app.asar.unpacked/native-bin/<platform>-<variant>/`,
 * the SAME `<platform>-<variant>` layout as the dev/CI roots, so the existing
 * capability walk applies unchanged. macOS only — Windows/Linux installs use
 * different bundle layouts; honor `GEZEL_LLAMA_SERVER_BIN` there instead.
 *
 * Note: deliberately not `~/.gezel-dev` — that home stores model *weights*,
 * not the engine binary.
 */
export function installedAppRoots(): string[] {
  if (process.platform !== 'darwin') return [];
  const rel = join('Gezel.app', 'Contents', 'Resources', 'app.asar.unpacked', 'native-bin');
  const bases = ['/Applications', join(homedir(), 'Applications')];
  return bases.map((base) => join(base, rel));
}

/**
 * Resolve the most-capable `llama-server` binary present. Resolution order:
 *
 *   1. `GEZEL_LLAMA_SERVER_BIN` — an explicit absolute path override. Lets a
 *      run on a machine with no local build work flag-free, and matches the
 *      env var the trial daemon itself reads ({@link import('./spawn.ts')}).
 *   2. The dev/CI roots, then an installed app bundle, each walked by variant
 *      precedence (CUDA → Vulkan → Metal → CPU) so we always pick the most
 *      capable backend regardless of which root carries it.
 *
 * Throws when nothing is found.
 */
export function resolveLlamaBinary(): ResolvedBinary {
  const envBin = process.env.GEZEL_LLAMA_SERVER_BIN?.trim();
  if (envBin) {
    if (existsSync(envBin)) return { path: envBin, variant: 'env' };
    // A set-but-missing override is almost always a typo worth surfacing
    // loudly rather than silently falling through to a different binary.
    throw new Error(`GEZEL_LLAMA_SERVER_BIN is set to "${envBin}" but no file exists there.`);
  }

  const roots = [...lookupRoots(), ...installedAppRoots()];
  const tried: string[] = [];
  for (const variant of LLAMA_BACKEND_PRECEDENCE) {
    for (const root of roots) {
      for (const exe of exeCandidates('llama-server')) {
        const path = join(root, `${platformKey()}-${variant}`, exe);
        tried.push(path);
        if (!existsSync(path)) continue;
        if (binaryLaunches(path)) return { path, variant };
        tried[tried.length - 1] = `${path} (exists but failed to launch — skipped)`;
      }
    }
  }
  // Variant-less fallback, mirroring the supervisor's native-bin.ts: on
  // platforms with a single shippable backend (macOS Metal), the local
  // `native/engines/llama-cpp/build.sh` stages into `<root>/<platform>/`
  // with no `-<backend>` suffix. Without this probe, a dev-built engine
  // resolves in the app but not in evals.
  for (const root of roots) {
    for (const exe of exeCandidates('llama-server')) {
      const path = join(root, platformKey(), exe);
      tried.push(path);
      if (!existsSync(path)) continue;
      if (binaryLaunches(path)) return { path, variant: null };
      tried[tried.length - 1] = `${path} (exists but failed to launch — skipped)`;
    }
  }
  const summary = tried.join('\n  ');
  throw new Error(
    `No llama-server binary found. Tried:\n  ${summary}\nBuild the engine into native/build/, install the Gezel desktop app, or set GEZEL_LLAMA_SERVER_BIN / pass --llama-bin.`,
  );
}

/**
 * A variant can exist on disk yet be unloadable on this machine — the
 * canonical case is the CI-staged CUDA build on a box with no NVIDIA
 * driver, which dies at load time with STATUS_DLL_NOT_FOUND (0xC0000135,
 * "nvcuda.dll was not found") before printing anything. Existence alone
 * therefore isn't enough: probe `--version` once per path and fall
 * through to the next variant on failure, so a Vulkan/CPU machine that
 * carries the CUDA folder still resolves a binary that actually starts.
 *
 * The probe goes through Node's spawn: libuv sets SEM_FAILCRITICALERRORS
 * / SEM_NOOPENFILEERRORBOX and children inherit it, so a load failure
 * returns an exit code instead of popping the blocking Windows
 * hard-error dialog. Results are memoized — resolution runs per trial
 * and the answer can't change mid-matrix.
 */
const launchProbeCache = new Map<string, boolean>();
function binaryLaunches(path: string): boolean {
  const cached = launchProbeCache.get(path);
  if (cached !== undefined) return cached;
  const result = spawnSync(path, ['--version'], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 15_000,
  });
  const ok = result.status === 0;
  launchProbeCache.set(path, ok);
  return ok;
}

/**
 * Resolve the `sd-server` binary. Single-variant engine, so we look
 * directly under `<root>/<platform>/sd-server[.exe]`. Returns null when
 * missing (image gen is optional for scenarios that don't need it).
 */
export function resolveSdBinary(): ResolvedBinary | null {
  for (const root of lookupRoots()) {
    for (const exe of exeCandidates('sd-server')) {
      const path = join(root, platformKey(), exe);
      if (existsSync(path)) return { path, variant: null };
    }
  }
  return null;
}

/**
 * Resolve the `ds4-server` (DeepSeek-V4) binary. One shippable backend per
 * platform (Metal on darwin-arm64, CUDA on linux), so we look directly under
 * `<root>/<platform>/ds4-server[.exe]` — the staged `metal/` shader dir sits
 * beside it, which `buildDs4Provider` relies on (it launches with cwd = the
 * binary's dir so ds4 finds `./metal/*.metal`). Honors GEZEL_DS4_SERVER_BIN
 * first. Returns null when missing (ds4 is opt-in per trial).
 */
export function resolveDs4Binary(): ResolvedBinary | null {
  const envBin = process.env.GEZEL_DS4_SERVER_BIN?.trim();
  if (envBin) {
    if (existsSync(envBin)) return { path: envBin, variant: 'env' };
    throw new Error(`GEZEL_DS4_SERVER_BIN is set to "${envBin}" but no file exists there.`);
  }
  for (const root of lookupRoots()) {
    for (const exe of exeCandidates('ds4-server')) {
      const path = join(root, platformKey(), exe);
      if (existsSync(path)) return { path, variant: null };
    }
  }
  return null;
}
