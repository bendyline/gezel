import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

/**
 * Build identity of a resolved engine binary. A trial record that names only
 * the *path* cannot distinguish two different builds staged at the same
 * location, which is how a stale engine survives a re-fetch unnoticed.
 */
export interface EngineBuild {
  /** llama.cpp build number from the `--version` banner, e.g. `10099`. */
  buildNumber: string | null;
  /**
   * Upstream commit. Prefers the 40-char sha from the `gezel-llama-build.json`
   * sidecar; falls back to the short sha in the banner.
   */
  revision: string | null;
  /** Backend the archive was built for (`cuda`/`cpu`/`metal`/`vulkan`). */
  backend: string | null;
  /** CUDA architectures baked into the binary, when the sidecar records them. */
  cudaArchitectures: string[] | null;
  /**
   * Whether `gezel-llama-build.json` was found beside the binary. Only fetched
   * or CI-staged trees carry one, so its absence marks a hand-built engine
   * whose build configuration nothing records.
   */
  sidecarPresent: boolean;
}

export interface ResolvedBinary {
  path: string;
  variant: string | null;
  /** Null for engines with no version banner or sidecar to read. */
  build: EngineBuild | null;
  /**
   * Provenance problems worth surfacing in the trial log: a build that
   * disagrees with the checkout's pin, an override nobody probed, or a
   * silent fall back to a less capable backend. Never throws on these —
   * every one of them is legitimate in some workflow — but a run that
   * doesn't say which engine produced its numbers is a run you cannot
   * attribute later.
   */
  warnings: string[];
}

/** Sidecar written next to every fetched/built llama binary by `build.sh`. */
const BUILD_SIDECAR = 'gezel-llama-build.json';

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
 *   1. `explicitPath` (the `--llama-bin` flag), then `GEZEL_LLAMA_SERVER_BIN`
 *      — an absolute path override. Lets a run on a machine with no local
 *      build work flag-free, and matches the env var the trial daemon itself
 *      reads ({@link import('./spawn.ts')}).
 *   2. The dev/CI roots, then an installed app bundle, each walked by variant
 *      precedence (CUDA → Vulkan → Metal → CPU) so we always pick the most
 *      capable backend regardless of which root carries it.
 *
 * Overrides are probed for build identity like any other candidate but are
 * never rejected: pointing them at a hand-built engine is their whole purpose.
 * Anything suspicious lands in `warnings` for the caller to log.
 *
 * Throws when nothing is found.
 */
export function resolveLlamaBinary(explicitPath?: string): ResolvedBinary {
  const flagBin = explicitPath?.trim();
  const envBin = process.env.GEZEL_LLAMA_SERVER_BIN?.trim();
  const override = flagBin || envBin;
  if (override) {
    const source = flagBin ? '--llama-bin' : 'GEZEL_LLAMA_SERVER_BIN';
    if (!existsSync(override)) {
      // A set-but-missing override is almost always a typo worth surfacing
      // loudly rather than silently falling through to a different binary.
      throw new Error(`${source} is set to "${override}" but no file exists there.`);
    }
    const probe = probeBinary(override);
    const resolved: ResolvedBinary = {
      path: override,
      variant: flagBin ? 'flag' : 'env',
      build: describeBuild(override, probe),
      warnings: [],
    };
    if (!probe.ok) {
      resolved.warnings.push(
        `${source} points at "${override}", which exists but did not respond to --version. An override bypasses the capability walk entirely, so nothing else will be tried.`,
      );
    }
    resolved.warnings.push(...pinWarnings(resolved, source));
    return resolved;
  }

  const roots = [...lookupRoots(), ...installedAppRoots()];
  const tried: string[] = [];
  const skipped: string[] = [];
  for (const variant of LLAMA_BACKEND_PRECEDENCE) {
    for (const root of roots) {
      for (const exe of exeCandidates('llama-server')) {
        const path = join(root, `${platformKey()}-${variant}`, exe);
        tried.push(path);
        if (!existsSync(path)) continue;
        const probe = probeBinary(path);
        if (probe.ok) return finish(path, variant, probe, skipped);
        tried[tried.length - 1] = `${path} (exists but failed to launch — skipped)`;
        skipped.push(`${variant} (${path})`);
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
      const probe = probeBinary(path);
      if (probe.ok) return finish(path, null, probe, skipped);
      tried[tried.length - 1] = `${path} (exists but failed to launch — skipped)`;
      skipped.push(`variant-less (${path})`);
    }
  }
  const summary = tried.join('\n  ');
  throw new Error(
    `No llama-server binary found. Tried:\n  ${summary}\nBuild the engine into native/build/, install the Gezel desktop app, or set GEZEL_LLAMA_SERVER_BIN / pass --llama-bin.`,
  );
}

/**
 * Assemble the resolution result, turning any variant we walked past into a
 * warning. A CUDA build that exists but won't load is skipped silently by the
 * precedence walk and the trial then runs on CPU — plausible numbers, wrong
 * backend, roughly a 4x decode cliff on a GPU box. That has happened here
 * before (a mixed-`.so` CUDA bundle dying on spawn with `undefined symbol`),
 * and the only trace was a path in a log nobody re-read.
 */
function finish(
  path: string,
  variant: string | null,
  probe: LaunchProbe,
  skipped: string[],
): ResolvedBinary {
  const resolved: ResolvedBinary = {
    path,
    variant,
    build: describeBuild(path, probe),
    warnings: [],
  };
  if (skipped.length > 0) {
    resolved.warnings.push(
      `resolved the ${variant ?? 'variant-less'} engine only after skipping ${skipped.join(', ')} — those binaries exist but failed --version, so this run is on a less capable backend than this machine carries.`,
    );
  }
  resolved.warnings.push(...pinWarnings(resolved, null));
  return resolved;
}

interface LaunchProbe {
  ok: boolean;
  buildNumber: string | null;
  revision: string | null;
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
 *
 * The banner this already pays for is also the binary's identity, so we
 * keep it rather than discarding it to `stdio: 'ignore'`.
 */
const launchProbeCache = new Map<string, LaunchProbe>();
function probeBinary(path: string): LaunchProbe {
  const cached = launchProbeCache.get(path);
  if (cached !== undefined) return cached;
  const result = spawnSync(path, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: 15_000,
  });
  // llama-server prints `version: <build> (<short-sha>)` on STDERR, not
  // stdout. Scan both so an upstream stream change doesn't silently blank
  // the field — a null revision disables the pin check rather than failing it.
  const banner = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  const match = /^version:\s*(\S+)\s+\(([0-9a-f]{7,40})\)/m.exec(banner);
  const probe: LaunchProbe = {
    ok: result.status === 0,
    buildNumber: match?.[1] ?? null,
    revision: match?.[2] ?? null,
  };
  launchProbeCache.set(path, probe);
  return probe;
}

/**
 * Merge the `--version` banner with the `gezel-llama-build.json` sidecar that
 * `native/engines/llama-cpp/build.sh` writes beside every binary it stages.
 * The sidecar carries the full 40-char commit plus the backend and CUDA
 * architectures, none of which the banner exposes.
 */
function describeBuild(path: string, probe: LaunchProbe): EngineBuild {
  let revision: string | null = null;
  let backend: string | null = null;
  let cudaArchitectures: string[] | null = null;
  let sidecarPresent = false;
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dirname(path), BUILD_SIDECAR), 'utf8'));
    if (raw && typeof raw === 'object') {
      sidecarPresent = true;
      const sidecar = raw as Record<string, unknown>;
      if (typeof sidecar.revision === 'string') revision = sidecar.revision;
      if (typeof sidecar.backend === 'string') backend = sidecar.backend;
      if (Array.isArray(sidecar.cudaArchitectures)) {
        cudaArchitectures = sidecar.cudaArchitectures.filter(
          (arch): arch is string => typeof arch === 'string',
        );
      }
    }
  } catch {
    // No sidecar (pre-rename build, hand-copied binary, unreadable JSON).
    // The banner alone still identifies the revision, but not the build config.
  }
  return {
    buildNumber: probe.buildNumber,
    revision: revision ?? probe.revision,
    backend,
    cudaArchitectures,
    sidecarPresent,
  };
}

/**
 * The upstream commit this checkout expects, from
 * `native/engines/llama-cpp/VERSION`. Returns null when the file is missing or
 * malformed, which disables the drift check rather than failing resolution.
 */
export function pinnedLlamaRevision(): string | null {
  try {
    const raw = readFileSync(join(repoRoot(), 'native', 'engines', 'llama-cpp', 'VERSION'), 'utf8');
    return /^commit=([0-9a-f]{7,40})\s*$/m.exec(raw)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Compare on the shorter of the two, so the sidecar's 40-char sha and the
 * banner's 8-char prefix are interchangeable.
 */
function revisionsMatch(a: string, b: string): boolean {
  const len = Math.min(a.length, b.length);
  return len >= 7 && a.slice(0, len) === b.slice(0, len);
}

function pinWarnings(resolved: ResolvedBinary, source: string | null): string[] {
  const pin = pinnedLlamaRevision();
  const via = source ? ` Selected via ${source}.` : '';
  const revision = resolved.build?.revision ?? null;

  if (!revision) {
    const against = pin ? `, so it cannot be checked against the pin ${pin.slice(0, 8)}` : '';
    return [
      `could not determine the build identity of ${resolved.path} (no --version banner, no ${BUILD_SIDECAR} beside it)${against}.${via}`,
    ];
  }
  if (pin && !revisionsMatch(pin, revision)) {
    return [
      `engine at ${resolved.path} was built from ${revision.slice(0, 8)} but this checkout pins ${pin.slice(0, 8)} (native/engines/llama-cpp/VERSION) — measurements from this run describe a different engine than the source tree.${via}`,
    ];
  }
  // A matching revision is not a matching binary. The sidecar is the only
  // record of the build *configuration*, and a release can change nothing but
  // cmake flags — 0.1.31 did exactly that (GGML_NATIVE=OFF, BACKEND_DL,
  // CPU_ALL_VARIANTS) at the same upstream commit as 0.1.29. A hand-built tree
  // sitting on the pinned commit therefore looks current by revision while
  // being compiled entirely differently.
  if (!resolved.build?.sidecarPresent) {
    return [
      `no ${BUILD_SIDECAR} beside ${resolved.path} — a hand-built or hand-copied engine. Its revision matches the pin, but the build configuration it was compiled with is unrecorded and may not match the released one.${via}`,
    ];
  }
  return [];
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
      if (existsSync(path)) return { path, variant: null, build: null, warnings: [] };
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
    if (existsSync(envBin)) return { path: envBin, variant: 'env', build: null, warnings: [] };
    throw new Error(`GEZEL_DS4_SERVER_BIN is set to "${envBin}" but no file exists there.`);
  }
  for (const root of lookupRoots()) {
    for (const exe of exeCandidates('ds4-server')) {
      const path = join(root, platformKey(), exe);
      if (existsSync(path)) return { path, variant: null, build: null, warnings: [] };
    }
  }
  return null;
}
