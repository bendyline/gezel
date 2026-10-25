/**
 * Service-side native-binary discovery.
 *
 * The Electron supervisor runs its own discovery in
 * `packages/app/src/supervisor/index.ts#connectOrStart` before spawning
 * the service, so embedded / dev / packaged-spawn launches already
 * have `GEZEL_LLAMA_SERVER_BIN`, `GEZEL_SD_SERVER_BIN`,
 * `GEZEL_WHISPER_SERVER_BIN`, `GEZEL_UV_BIN`, and
 * `GEZEL_DEVICE_HEALTH_BIN` in their env. The OS
 * system services (Windows NSSM `GezelService`, macOS LaunchDaemon
 * `com.bendyline.gezeld`, Linux `gezeld.service` systemd unit) do NOT
 * — they're started directly by the OS with a clean environment, so
 * the supervisor's env-stamping never reaches them. Without this
 * module, chat against the on-device provider fails with
 * "no local engine is available on this machine" on every packaged
 * install.
 *
 * Discovery rules per binary:
 *
 *   - `GEZEL_*_BIN` already set → no-op (supervisor or operator wins).
 *   - `GEZEL_NATIVE_BIN_DIR` unset → no-op (no source of binaries to
 *     probe). System-service installers stamp this var; bare CLI runs
 *     without it just get the existing actionable error on first chat.
 *   - llama-server: needs a backend probe (CUDA / Vulkan / Metal / CPU).
 *     Results are cached at `<home>/engines/llama-cpp/backend.json` —
 *     same file the supervisor writes, so the two share state.
 *   - sd-server / whisper-server / uv: variant-less, resolved directly
 *     under `<dir>/<platform>/<binary>`.
 *
 * Cross-platform note: same code on Windows, macOS, and Linux. The
 * `resolvePlatformKey` helper handles the per-OS subdirectory naming
 * (`win32-x64`, `win32-arm64`, `darwin-arm64`, `linux-x64`, `linux-arm64`).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { duckdbInstalledBinary } from './duckdb-pin.js';
import { detectLlamaBackend, resolveAvailableLlamaBinary } from './llama-backend.js';
import type { DetectInput, GpuVendorHint, LlamaBackend } from './llama-backend.js';
import { createLlamaBuildCheck, publishLlamaCudaBlocker } from './llama-build-check.js';
import { LLAMA_ENGINE_VERSION } from './llama-engine-version.js';
import { readLlamaQuarantine } from './llama-quarantine.js';
import type { LlamaQuarantineEntry } from './llama-quarantine.js';
import type { NvidiaCudaBlocker } from './nvidia-driver.js';
import { resolvePlatformKey } from './platform-key.js';

export type NativeBinaryName =
  | 'llama-server'
  | 'ds4-server'
  | 'sd-server'
  | 'whisper-server'
  | 'device-health'
  | 'uv'
  | 'duckdb'
  /** macOS 26+ bridge to Apple's on-device model (native/helpers/apple-fm). */
  | 'apple-fm';

export interface DiscoverInput {
  /** GEZEL_HOME — backend cache file lives at `<home>/engines/llama-cpp/`. */
  home: string;
  /**
   * Optional user-pinned backend override (from `GezelConfig.
   * llamaCppBackendOverride`). Forwarded to the probe unchanged. The
   * supervisor reads this from config.json directly; the service has
   * already loaded config by the time discovery runs, so the caller
   * can pass the resolved value in.
   */
  llamaCppBackendOverride?: 'auto' | LlamaBackend;
  /**
   * Override the native-bin root (test-only). Production callers leave
   * this unset and let the function read `GEZEL_NATIVE_BIN_DIR`.
   */
  nativeBinDirOverride?: string;
  /** Test seam — production callers default to `process.platform` / `process.arch`. */
  platform?: NodeJS.Platform;
  arch?: string;
  /** Test seam for existence checks; defaults to `node:fs.existsSync`. */
  fileExists?: (p: string) => boolean;
  /**
   * Test seam — forwarded to `detectLlamaBackend` so tests can fake
   * driver presence (`libcuda.so.1`, `nvcuda.dll`, vendor sysfs).
   * Production callers leave this unset and the probe uses real fs.
   */
  llamaProbeOverride?: DetectInput['probe'];
  /**
   * Test seam — pre-read quarantine entries. Production callers leave
   * this unset and the list is read from `<home>/engines/llama-cpp/`.
   */
  quarantine?: readonly LlamaQuarantineEntry[];
  /**
   * Test seam — the NVIDIA driver check for a Linux CUDA build
   * (nvidia-driver.ts). Production callers leave it unset and the host's
   * driver is read.
   */
  cudaBlockerFor?: (binaryPath: string) => NvidiaCudaBlocker | null;
  /** Optional logger; the service passes its own to thread service-style logs. */
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
}

export interface DiscoverResult {
  /** One entry per binary the discovery attempted. */
  binaries: Array<{
    /**
     * `sqlite-vec` is a SQLite extension the service loads in-process
     * (native/engines/sqlite-vec), not an engine the resolver can fetch or
     * start, so it stays out of {@link NativeBinaryName}.
     */
    name: NativeBinaryName | 'sqlite-vec';
    /** `'pre-set'` — env var was already populated, discovery skipped. */
    source: 'pre-set' | 'discovered' | 'no-native-bin-dir' | 'no-platform-key' | 'not-found';
    /** Resolved path when `source` is `'pre-set'` or `'discovered'`. */
    path?: string;
    /**
     * For llama-server, the picked backend (so logs can record
     * "discovered cuda variant"). Undefined for variant-less binaries.
     */
    variant?: LlamaBackend;
  }>;
  /** Backend probe result, present when llama-server discovery ran. */
  llamaBackend?: {
    backend: LlamaBackend;
    detectedBackend: LlamaBackend;
    reason: string;
    cached: boolean;
    vendorHint?: GpuVendorHint;
    /**
     * Backends skipped because they crashed on this machine. Present so
     * the UI can say the GPU engine was demoted rather than leaving the
     * user to infer it from a slow session.
     */
    quarantined?: LlamaBackend[];
    /** Why the CUDA build was passed over for one the driver can run. */
    cudaBlocker?: NvidiaCudaBlocker;
  };
}

/**
 * Resolve a single bundled binary under `<root>/<subdir>/<file>`. The
 * `subdir` is `<platform>[-<variant>]`; the file is `<name>[.exe]`.
 *
 * Returns `null` when the file isn't on disk. Caller decides whether
 * to fall through to a variant-less subdir or surface "not found."
 */
/**
 * Binaries we vendor unmodified from an upstream release. They keep the
 * upstream file name — no `gezel-` prefix — because the bytes are the
 * vendor's and the Windows signing allowlist
 * (packages/app/scripts/third-party-binaries.cjs) matches on exactly that
 * name. Everything we compile is emitted as `gezel-<name>`.
 *
 * DuckDB is vendored too, but it is not in `native-bin/` at all — it ships as
 * a bundled runtime beside node and pnpm, and resolves from its own
 * version-keyed directory below.
 */
const UNPREFIXED_BINARIES = new Set<NativeBinaryName>(['uv']);

export function resolveNativeBinaryUnder(
  root: string,
  name: NativeBinaryName,
  subdir: string,
  platform: NodeJS.Platform = process.platform,
  fileExists: (p: string) => boolean = existsSync,
): string | null {
  const ext = platform === 'win32' ? '.exe' : '';
  // Build scripts emit the binary under a `gezel-` prefix (the process shows
  // as `gezel-llama-server` in Task Manager / GPU listings — Gezel attribution,
  // upstream lineage kept in the suffix). Prefer that, fall back to the bare
  // upstream name so binaries bundled BEFORE the rename still resolve. `uv`
  // and `duckdb` are vendored unmodified and never prefixed; they resolve by
  // their bare upstream name only. `name` stays the logical/upstream
  // identifier everywhere else.
  const candidates = UNPREFIXED_BINARIES.has(name)
    ? [`${name}${ext}`]
    : [`gezel-${name}${ext}`, `${name}${ext}`];
  for (const file of candidates) {
    const p = join(root, subdir, file);
    if (fileExists(p)) return p;
  }
  return null;
}

/**
 * Whether this platform's `-cuda` archive carries a CUDA build of `name`
 * beside llama-server's, to prefer over the portable build in the bare key
 * when this host runs CUDA (scripts/native-payload.mjs). Windows x64's holds
 * llama-server alone; whisper-server's CUDA build is Windows-on-ARM only.
 * ds4-server is not a choice: on Linux it ships only in `-cuda`.
 */
export function cudaArchiveCarries(
  name: NativeBinaryName,
  platform: NodeJS.Platform,
  arch: string,
): boolean {
  const windowsOnArm = platform === 'win32' && arch === 'arm64';
  if (name === 'sd-server') return platform === 'linux' || windowsOnArm;
  if (name === 'whisper-server') return windowsOnArm;
  return false;
}

/** Whether an engine path is one of those builds, which live in `<platform>-cuda/`. */
export function isCudaArchivePath(path: string): boolean {
  return /-cuda[\\/][^\\/]+$/.test(path);
}

/**
 * Discover bundled native binaries and stamp the matching env vars on
 * `process.env`. Idempotent: a second call after the env is set is a
 * no-op. Tolerant of partial bundling — a missing binary just leaves
 * its env var unset; the dependent provider then surfaces its own
 * actionable error on first use.
 */
export function discoverNativeBinaries(input: DiscoverInput): DiscoverResult {
  const log = input.logger;
  const fileExists = input.fileExists ?? existsSync;
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const dir = input.nativeBinDirOverride ?? process.env.GEZEL_NATIVE_BIN_DIR;

  const binaries: DiscoverResult['binaries'] = [];
  const result: DiscoverResult = { binaries };

  const platformKey = resolvePlatformKey(platform, arch);
  if (!platformKey) {
    // Unsupported platform/arch — nothing to probe.
    for (const name of [
      'llama-server',
      'ds4-server',
      'sd-server',
      'whisper-server',
      'device-health',
      'uv',
      'duckdb',
      'sqlite-vec',
    ] as const) {
      binaries.push({ name, source: 'no-platform-key' });
    }
    return result;
  }

  // ── llama-server (variant-aware) ───────────────────────────────────
  if (process.env.GEZEL_LLAMA_SERVER_BIN) {
    binaries.push({
      name: 'llama-server',
      source: 'pre-set',
      path: process.env.GEZEL_LLAMA_SERVER_BIN,
    });
  } else {
    const probe = detectLlamaBackend({
      engineVersion: LLAMA_ENGINE_VERSION,
      home: input.home,
      ...(input.llamaCppBackendOverride ? { override: input.llamaCppBackendOverride } : {}),
      ...(input.llamaProbeOverride
        ? { probe: { ...input.llamaProbeOverride, platform, arch: arch as NodeJS.Architecture } }
        : { probe: { platform, arch: arch as NodeJS.Architecture } }),
    });
    // Publish the probe result regardless of whether the matching
    // binary is bundled. The Settings UI / Home tab reads
    // `GEZEL_LLAMA_DETECTED_BACKEND` and `GEZEL_LLAMA_DETECTED_VENDOR`
    // to populate the backend dropdown and the engine vendor label;
    // without it, the user can't see what hardware they have.
    process.env.GEZEL_LLAMA_DETECTED_BACKEND = probe.detectedBackend;
    if (probe.vendorHint) {
      process.env.GEZEL_LLAMA_DETECTED_VENDOR = probe.vendorHint;
    }
    result.llamaBackend = {
      backend: probe.backend,
      detectedBackend: probe.detectedBackend,
      reason: probe.reason,
      cached: probe.cached,
      ...(probe.vendorHint ? { vendorHint: probe.vendorHint } : {}),
    };
    if (!dir) {
      binaries.push({ name: 'llama-server', source: 'no-native-bin-dir', variant: probe.backend });
    } else {
      const allowFallbacks =
        input.llamaCppBackendOverride === undefined || input.llamaCppBackendOverride === 'auto';
      // Builds that crashed on this machine before ever becoming ready
      // are routed around — see llama-quarantine.ts. Read once per
      // discovery; the common case is an empty list and no extra I/O
      // beyond the (missing) file.
      const quarantine = input.quarantine ?? readLlamaQuarantine(input.home);
      const check = createLlamaBuildCheck({
        quarantine,
        platform,
        ...(input.cudaBlockerFor ? { cudaBlockerFor: input.cudaBlockerFor } : {}),
      });
      const resolved = resolveAvailableLlamaBinary(
        probe.backend,
        (backend) =>
          resolveNativeBinaryUnder(
            dir,
            'llama-server',
            `${platformKey}-${backend}`,
            platform,
            fileExists,
          ) ??
          // Variant-less fallback covers Mac's single Metal build and
          // native trees staged before multi-variant packaging.
          resolveNativeBinaryUnder(dir, 'llama-server', platformKey, platform, fileExists),
        allowFallbacks,
        check.isUsable,
      );
      const cudaBlocker = check.cudaBlocker();
      publishLlamaCudaBlocker(cudaBlocker);
      if (cudaBlocker) {
        result.llamaBackend.cudaBlocker = cudaBlocker;
        log?.warn?.(
          `[native] llama-server cuda build passed over: ${cudaBlocker.detail} (${cudaBlocker.kind})`,
        );
      }
      if (resolved) {
        process.env.GEZEL_LLAMA_SERVER_BIN = resolved.path;
        process.env.GEZEL_LLAMA_SERVER_BACKEND = resolved.backend;
        // Two different demotions, and conflating them sends whoever
        // reads the log looking for a packaging bug that isn't there.
        // `skippedUnusable` means the build shipped and does not run
        // here; `fallbackFrom` alone means it was never bundled.
        const quarantined = check.quarantinedOf(resolved.skippedUnusable ?? []);
        for (const skipped of quarantined) {
          const entry = quarantine.find((e) => e.backend === skipped);
          log?.warn?.(
            `[native] llama-server ${skipped} build is quarantined on this machine ` +
              `(${entry?.signal ?? 'crashed'} at ${entry?.at ?? 'unknown time'}): ${entry?.reason ?? 'crashed before becoming ready'}`,
          );
        }
        if (resolved.skippedUnusable?.length) {
          result.llamaBackend.backend = resolved.backend;
          const why = [
            ...(quarantined.length > 0
              ? [`${quarantined.join(', ')} quarantined after crashing on this machine`]
              : []),
            ...(cudaBlocker ? [`cuda passed over (${cudaBlocker.kind})`] : []),
          ];
          result.llamaBackend.reason = `${probe.reason}; ${why.join('; ')}, using ${resolved.backend}`;
          if (quarantined.length > 0) {
            result.llamaBackend.quarantined = quarantined;
            // Published like the other backend facts so /api/health can
            // forward it — a demotion the user never sees is the failure
            // mode this whole mechanism exists to end.
            process.env.GEZEL_LLAMA_QUARANTINED = quarantined.join(',');
          }
        } else if (resolved.fallbackFrom) {
          result.llamaBackend.backend = resolved.backend;
          result.llamaBackend.reason = `${probe.reason}; no bundled ${resolved.fallbackFrom} binary, using ${resolved.backend}`;
          log?.info?.(
            `[native] no bundled llama-server for ${resolved.fallbackFrom}; using ${resolved.backend} fallback: ${resolved.path}`,
          );
        }
        binaries.push({
          name: 'llama-server',
          source: 'discovered',
          path: resolved.path,
          variant: resolved.backend,
        });
        log?.info?.(
          `[native] discovered llama-server (${resolved.backend}${probe.cached ? ', cached' : ''}): ${resolved.path}`,
        );
      } else {
        binaries.push({ name: 'llama-server', source: 'not-found', variant: probe.backend });
        // A missing native tree is the normal state of a fresh npm/CLI install
        // (engines download on demand), so it is not worth a warning on every
        // boot. A tree that exists but lacks the binary is a packaging fault.
        const message = `[native] no llama-server binary bundled for ${probe.backend} under ${dir} (probe: ${probe.reason})`;
        if (fileExists(dir)) log?.warn?.(message);
        else log?.info?.(message);
      }
    }
  }

  // ── duckdb (own versioned directory, not native-bin) ───────────────
  // DuckDB is redistributed exactly as the DuckDB Foundation published it, so
  // it never entered the native release; the Electron supervisor and the
  // service's engine resolver both install it to `<home>/engines/duckdb/
  // <version>/`. This probe is what makes it reachable from an OS system
  // service, which is started with a clean environment and so never sees the
  // supervisor's env stamping.
  if (process.env.GEZEL_DUCKDB_BIN) {
    binaries.push({ name: 'duckdb', source: 'pre-set', path: process.env.GEZEL_DUCKDB_BIN });
  } else {
    const duckBin = duckdbInstalledBinary(input.home, platform);
    if (fileExists(duckBin)) {
      process.env.GEZEL_DUCKDB_BIN = duckBin;
      binaries.push({ name: 'duckdb', source: 'discovered', path: duckBin });
      log?.info?.(`[native] duckdb: ${duckBin}`);
    } else {
      binaries.push({ name: 'duckdb', source: 'not-found' });
    }
  }

  // ── Variant-less binaries (ds4-server / sd-server / whisper-server / uv) ────────
  // ds4-server ships exactly ONE build per supported platform (Metal on
  // darwin-arm64, CUDA on linux-x64/arm64; nothing on darwin-x64 / win32), so
  // — unlike llama-server, which probes among multiple same-platform backends
  // — there is no runtime choice to make. It is still not always in the bare
  // key: on Linux it lives under `<platformKey>-cuda`, co-located with
  // llama-server's CUDA build so the two share one copy of the NVIDIA
  // redistributables rather than shipping 828 MB of them twice (see
  // scripts/native-payload.mjs). macOS keeps it in the bare key.
  //
  // `subdirFor` encodes that. The lookup below then falls back to the bare
  // key, the same way the llama-server branch above falls back from its
  // variant directory — so a native-bin tree staged BEFORE the move (ds4 in
  // the bare key) still resolves and an in-place upgrade doesn't lose ds4.
  // On unsupported platforms the binary is simply absent → 'not-found' → the
  // provider's actionable error / the UI availability probe hides ds4.
  // sd-server rides the same `-cuda` key on Linux and Windows on ARM (and
  // whisper-server on Windows on ARM; `cudaArchiveCarries`), but the choice
  // is a capability question rather than a fact about where the archive is:
  // unlike ds4, sd-cpp ALSO ships a portable build in the bare
  // key, and installers stage every variant for the platform — so a
  // non-NVIDIA host has a `-cuda` directory sitting right there, and
  // preferring it blindly would hand that host a CUDA-linked binary that dies
  // at exec before sd.cpp can fall back.
  //
  // Reuse llama's resolved backend rather than probing again. It answers the
  // same question, it is already memoized, and it honours
  // `llamaCppBackendOverride` — so a user who pinned `cpu` to work around a
  // broken CUDA install gets a working sd-server too, which is what they
  // meant. When llama's binary was pre-set the probe never ran and this is
  // undefined; the bare key is then the safe answer, and in that path the
  // supervisor has already stamped GEZEL_SD_SERVER_BIN anyway.
  const cudaCapable = result.llamaBackend?.backend === 'cuda';
  const subdirFor = (name: NativeBinaryName): string =>
    (platform === 'linux' && name === 'ds4-server') ||
    (cudaCapable && cudaArchiveCarries(name, platform, arch))
      ? `${platformKey}-cuda`
      : platformKey;
  for (const { name, envVar } of [
    { name: 'ds4-server' as const, envVar: 'GEZEL_DS4_SERVER_BIN' },
    { name: 'sd-server' as const, envVar: 'GEZEL_SD_SERVER_BIN' },
    { name: 'whisper-server' as const, envVar: 'GEZEL_WHISPER_SERVER_BIN' },
    { name: 'device-health' as const, envVar: 'GEZEL_DEVICE_HEALTH_BIN' },
    { name: 'uv' as const, envVar: 'GEZEL_UV_BIN' },
    ...(platform === 'darwin' ? [{ name: 'apple-fm' as const, envVar: 'GEZEL_APPLE_FM_BIN' }] : []),
  ]) {
    if (process.env[envVar]) {
      binaries.push({ name, source: 'pre-set', path: process.env[envVar] });
      continue;
    }
    if (!dir) {
      binaries.push({ name, source: 'no-native-bin-dir' });
      continue;
    }
    const subdir = subdirFor(name);
    const bin =
      resolveNativeBinaryUnder(dir, name, subdir, platform, fileExists) ??
      (subdir === platformKey
        ? null
        : resolveNativeBinaryUnder(dir, name, platformKey, platform, fileExists));
    if (bin) {
      process.env[envVar] = bin;
      binaries.push({ name, source: 'discovered', path: bin });
      log?.info?.(`[native] discovered ${name}: ${bin}`);
    } else {
      binaries.push({ name, source: 'not-found' });
    }
  }

  // ── sqlite-vec (a SQLite extension, loaded into the service's process) ──
  // npm's sqlite-vec has prebuilds for every platform but Windows ARM64, which
  // the native release builds instead. Discovery only stamps the path; the
  // sqlite driver tries it before the npm copy. Absent everywhere else, so a
  // miss is not worth a log line. The file keeps upstream's `vec0` name:
  // SQLite derives the extension's entry point from it.
  if (process.env.GEZEL_SQLITE_VEC_PATH) {
    binaries.push({
      name: 'sqlite-vec',
      source: 'pre-set',
      path: process.env.GEZEL_SQLITE_VEC_PATH,
    });
  } else if (!dir) {
    binaries.push({ name: 'sqlite-vec', source: 'no-native-bin-dir' });
  } else {
    const ext = platform === 'win32' ? 'dll' : platform === 'darwin' ? 'dylib' : 'so';
    const path = join(dir, platformKey, `vec0.${ext}`);
    if (fileExists(path)) {
      process.env.GEZEL_SQLITE_VEC_PATH = path;
      binaries.push({ name: 'sqlite-vec', source: 'discovered', path });
      log?.info?.(`[native] discovered sqlite-vec: ${path}`);
    } else {
      binaries.push({ name: 'sqlite-vec', source: 'not-found' });
    }
  }

  return result;
}
