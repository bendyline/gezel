/**
 * Runtime backend detection for the bundled llama-server.
 *
 * Phase 2 ships multiple llama-server variants per platform — CUDA
 * + Vulkan + CPU on Linux/Windows, Metal on macOS — and this module
 * picks which one to launch on a given host. The probe is pure
 * filesystem / linker inspection; it does NOT spawn a GPU workload.
 * A binary that loads cleanly here might still fail at first
 * inference if the driver is broken — the supervisor handles that
 * by falling through to the next variant on launch failure.
 *
 * Usage from the Electron supervisor:
 *
 *   import { detectLlamaBackend } from './llama-backend.js';
 *   import { resolveNativeBinaryPath } from './native-bin.js';
 *
 *   const probe = detectLlamaBackend({
 *     engineVersion: 'b9843',
 *     home: gezelHome,
 *   });
 *   const bin = resolveNativeBinaryPath('llama-server', import.meta.url, probe.backend);
 *
 * Caching: the result is memoized at
 * `<home>/engines/llama-cpp/backend.json` so subsequent launches
 * skip the probe. Cache invalidates whenever `engineVersion`
 * changes — bumping the llama.cpp pin may prefer a different
 * backend.
 */

import { execSync } from 'node:child_process';
import {
  constants,
  accessSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { arch as nodeArch, platform as nodePlatform } from 'node:process';

export type LlamaBackend = 'cuda' | 'vulkan' | 'metal' | 'cpu';

/**
 * Which GPU vendor the host *primarily* has, independent of which
 * llama-server backend was picked. Used to label the running engine
 * in the UI: a Radeon user on the Vulkan backend should see "AMD GPU"
 * not just "GPU." `cuda` already implies NVIDIA, so the vendor field
 * is most useful for disambiguating Vulkan and CPU fallbacks.
 *
 * Detection is best-effort and pure filesystem inspection — no shell-out
 * to wmic / lspci. `undefined` means we couldn't tell; the UI should
 * fall back to a generic label.
 */
export type GpuVendorHint = 'amd' | 'nvidia' | 'intel';

export interface DetectInput {
  /** Engine pin from native/engines/llama-cpp/VERSION (e.g. 'b9843'). Bumps invalidate the cache. */
  engineVersion: string;
  /** GEZEL_HOME — backend cache lives at `<home>/engines/llama-cpp/backend.json`. */
  home: string;
  /**
   * User-pinned backend (from `config.llamaCppBackendOverride`). When
   * set to a concrete backend (`cuda` / `vulkan` / `metal` / `cpu`),
   * the auto-probe is skipped and the chosen backend is returned
   * verbatim — even if the OS doesn't have the corresponding driver.
   * `resolveNativeBinaryPath` will then fail to find the binary and
   * the supervisor surfaces an actionable error (which is the right
   * behavior — the user picked an unavailable backend, we tell them).
   *
   * `'auto'` or `undefined` keeps the existing CUDA → Vulkan → CPU
   * (or Metal on Mac) probe behavior.
   *
   * Cache bypass: when an override is in effect we don't read OR write
   * the cache file. The override is the source of truth; we don't want
   * a future `'auto'` to come back and re-use what was actually a
   * forced choice.
   */
  override?: 'auto' | 'cuda' | 'vulkan' | 'metal' | 'cpu';
  /** Optional injection points for tests. */
  probe?: {
    fileExists?: (path: string) => boolean;
    commandOk?: (cmd: string) => boolean;
    /**
     * Read a small text file (no size limit checks — the caller only
     * uses this on tiny sysfs files like
     * `/sys/class/drm/card0/device/vendor`). Returns `undefined` for
     * any failure mode (missing, EACCES, etc.) — the caller treats
     * that the same as "vendor unknown."
     */
    readFileText?: (path: string) => string | undefined;
    /**
     * List a directory's entries. Used to enumerate `/sys/class/drm/`
     * for `card*` devices. Returns `[]` for any failure mode
     * (directory missing on non-Linux containers, permission denied).
     */
    readDir?: (path: string) => string[];
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
  };
}

export interface DetectResult {
  /**
   * What the supervisor should use for this launch. When the user pinned
   * `config.llamaCppBackendOverride`, this is the override; otherwise it's
   * the hardware-probe result (same as `detectedBackend`).
   */
  backend: LlamaBackend;
  /**
   * What the hardware probe found, independent of any override. The
   * Settings UI uses this to populate the dropdown so a `cpu` pin on a
   * CUDA machine still shows CUDA / Vulkan as switchable options.
   *
   * Equal to `backend` when no override is in effect.
   */
  detectedBackend: LlamaBackend;
  cached: boolean;
  /** Human-readable explanation of why this backend was chosen. */
  reason: string;
  /** ISO 8601 timestamp of when the underlying probe ran (cache hits show the cached value). */
  probedAt: string;
  /**
   * Best-effort guess of the host's primary GPU vendor. Independent of
   * the backend pick — a Radeon user on the Vulkan backend reports
   * `vendorHint='amd'` so the UI can label the engine "AMD GPU"
   * instead of the generic "GPU." `undefined` when no GPU could be
   * identified (e.g. headless container, macOS where the field is
   * meaningless because Apple Silicon is unified memory).
   */
  vendorHint?: GpuVendorHint;
}

/**
 * Bumped whenever the probe's *logic* changes in a way that may
 * upgrade a previously-cached `cpu` to a real GPU backend (or vice
 * versa). Existing on-disk caches written before this version are
 * treated as misses so they re-probe. Bump alongside any probe
 * change that broadens what the probe can recognize.
 *
 * Version history:
 *   1 — linux-arm64 support: dispatch arm64 through detectLinuxOrWin,
 *       add aarch64-linux-gnu paths to CUDA/Vulkan lookups.
 */
const PROBE_SCHEMA_VERSION = 1;

interface CacheFile {
  /** Schema version of the probe that wrote this file. Missing on entries written by older versions of Gezel. */
  probeSchemaVersion?: number;
  engineVersion: string;
  backend: LlamaBackend;
  reason: string;
  probedAt: string;
  vendorHint?: GpuVendorHint;
}

function fileExistsDefault(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function anyExists(paths: string[], probe: (p: string) => boolean): string | null {
  for (const p of paths) {
    if (probe(p)) return p;
  }
  return null;
}

function commandOkDefault(cmd: string): boolean {
  try {
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function readFileTextDefault(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function readDirDefault(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/**
 * Identify the host's primary GPU vendor from cheap, pure filesystem
 * inspection. Caller decides what to do with it (currently: just label
 * the engine in the UI). No backend decision flows from this — that's
 * still driven by which driver libs are present.
 *
 * **Linux**: enumerate `/sys/class/drm/cardN/device/vendor` for each
 * `cardN` entry. Each is a 6-byte text file like `0x1002` (PCI vendor
 * ID, newline-terminated). Discrete-card
 * priority: NVIDIA > AMD > Intel, because hybrid laptops typically
 * have an Intel iGPU alongside whatever discrete the user actually
 * cares about.
 *
 * **Windows**: probe System32 for vendor-specific driver DLLs. NVIDIA
 * ships `nvcuda.dll` / `nvapi64.dll` with the display driver; AMD
 * ships `aticfx64.dll` / `amdxc64.dll` (Adrenalin) and optionally
 * `amdhip64*.dll` if the HIP runtime is installed; Intel ships
 * `igdumdim64.dll`. Same priority order as Linux.
 *
 * **macOS**: not called — Apple Silicon GPUs aren't PCI devices and
 * the vendor concept doesn't add information beyond `metal`.
 */
function detectVendor(
  os: 'linux' | 'win32',
  probeFile: (p: string) => boolean,
  readFileText: (p: string) => string | undefined,
  readDir: (p: string) => string[],
): GpuVendorHint | undefined {
  if (os === 'linux') {
    const found = new Set<GpuVendorHint>();
    for (const entry of readDir('/sys/class/drm')) {
      if (!/^card\d+$/.test(entry)) continue;
      const vid = readFileText(`/sys/class/drm/${entry}/device/vendor`)?.trim().toLowerCase();
      if (vid === '0x1002') found.add('amd');
      else if (vid === '0x10de') found.add('nvidia');
      else if (vid === '0x8086') found.add('intel');
    }
    if (found.has('nvidia')) return 'nvidia';
    if (found.has('amd')) return 'amd';
    if (found.has('intel')) return 'intel';
    return undefined;
  }
  const sys32 = process.env.SYSTEMROOT
    ? join(process.env.SYSTEMROOT, 'System32')
    : 'C:\\Windows\\System32';
  if (probeFile(join(sys32, 'nvcuda.dll')) || probeFile(join(sys32, 'nvapi64.dll'))) {
    return 'nvidia';
  }
  if (
    probeFile(join(sys32, 'aticfx64.dll')) ||
    probeFile(join(sys32, 'amdxc64.dll')) ||
    probeFile(join(sys32, 'amdhip64.dll'))
  ) {
    return 'amd';
  }
  if (probeFile(join(sys32, 'igdumdim64.dll')) || probeFile(join(sys32, 'igc64.dll'))) {
    return 'intel';
  }
  return undefined;
}

function detectLinuxOrWin(
  os: 'linux' | 'win32',
  probeFile: (p: string) => boolean,
  probeCmd: (c: string) => boolean,
  readFileText: (p: string) => string | undefined,
  readDir: (p: string) => string[],
): { backend: LlamaBackend; reason: string; vendorHint?: GpuVendorHint } {
  const vendorHint = detectVendor(os, probeFile, readFileText, readDir);
  // ── CUDA probe ─────────────────────────────────────────────────
  // We care about the DRIVER, not the toolkit — bundled
  // llama-server-cuda ships its own cudart alongside it. Linux
  // driver ships libcuda.so.1; Windows driver ships nvcuda.dll
  // (and nvml.dll for monitoring).
  if (os === 'linux') {
    // Debian-style multiarch dirs ship the driver lib under
    // `/usr/lib/<gnu-triplet>/`; the triplet differs by arch
    // (`x86_64-linux-gnu` vs `aarch64-linux-gnu`). RPM-style hosts
    // and bare /usr/lib fallbacks cover both. Without the aarch64
    // entry, linux-arm64 boxes (Jetson, DGX Spark, Grace Hopper)
    // probe negative and pin themselves to CPU forever.
    const libcuda = anyExists(
      [
        '/usr/lib/x86_64-linux-gnu/libcuda.so.1',
        '/usr/lib/aarch64-linux-gnu/libcuda.so.1',
        '/usr/lib64/libcuda.so.1',
        '/usr/lib/libcuda.so.1',
        '/lib/x86_64-linux-gnu/libcuda.so.1',
        '/lib/aarch64-linux-gnu/libcuda.so.1',
      ],
      probeFile,
    );
    if (libcuda) {
      // nvidia-smi being responsive is a second signal that the
      // driver is actually live, not just installed-but-broken.
      // Tolerant — we don't gate on it; just include it in the
      // reason for diagnostics.
      const smiOk = probeCmd('nvidia-smi -L');
      return {
        backend: 'cuda',
        reason: `found ${libcuda}${smiOk ? ', nvidia-smi ok' : ', nvidia-smi absent or failing (proceeding anyway)'}`,
        vendorHint,
      };
    }
  } else {
    const sys32 = process.env.SYSTEMROOT
      ? join(process.env.SYSTEMROOT, 'System32')
      : 'C:\\Windows\\System32';
    const nvcuda = anyExists([join(sys32, 'nvcuda.dll'), join(sys32, 'nvml.dll')], probeFile);
    if (nvcuda) {
      return { backend: 'cuda', reason: `found ${nvcuda}`, vendorHint };
    }
  }

  // ── Vulkan probe ───────────────────────────────────────────────
  if (os === 'linux') {
    const libvulkan = anyExists(
      [
        '/usr/lib/x86_64-linux-gnu/libvulkan.so.1',
        '/usr/lib/aarch64-linux-gnu/libvulkan.so.1',
        '/usr/lib64/libvulkan.so.1',
        '/usr/lib/libvulkan.so.1',
      ],
      probeFile,
    );
    if (libvulkan) {
      // Could probe for a physical device via `vulkaninfo --summary`
      // but it's slow and not always installed. Trust the loader
      // being present; llama-server raises a clear error on no-device,
      // and the supervisor can fall through on launch failure.
      return { backend: 'vulkan', reason: `found ${libvulkan}`, vendorHint };
    }
  } else {
    const sys32 = process.env.SYSTEMROOT
      ? join(process.env.SYSTEMROOT, 'System32')
      : 'C:\\Windows\\System32';
    const vk = anyExists([join(sys32, 'vulkan-1.dll')], probeFile);
    if (vk) {
      return { backend: 'vulkan', reason: `found ${vk}`, vendorHint };
    }
  }

  return { backend: 'cpu', reason: 'no CUDA driver and no Vulkan loader found', vendorHint };
}

export function detectLlamaBackend(input: DetectInput): DetectResult {
  // Always run the hardware probe (cache-friendly), even when an
  // override is in effect. We need the true detected value so the
  // Settings UI can show all of the user's actual options — without
  // it, picking `cpu` on a CUDA machine would hide CUDA from the
  // dropdown and the user couldn't switch back without hand-editing
  // config.json.
  const probed = probeOrCached(input);

  if (input.override && input.override !== 'auto') {
    return {
      backend: input.override,
      detectedBackend: probed.backend,
      cached: probed.cached,
      reason: `pinned by config.llamaCppBackendOverride=${input.override} (hardware probe: ${probed.reason})`,
      probedAt: probed.probedAt,
      ...(probed.vendorHint ? { vendorHint: probed.vendorHint } : {}),
    };
  }

  return {
    backend: probed.backend,
    detectedBackend: probed.backend,
    cached: probed.cached,
    reason: probed.reason,
    probedAt: probed.probedAt,
    ...(probed.vendorHint ? { vendorHint: probed.vendorHint } : {}),
  };
}

/**
 * Hardware probe with cache memoization. No override handling — the
 * caller layers that on top. Returns just the four fields shared
 * between the override and no-override paths, plus the optional
 * `vendorHint` for UI labeling.
 */
function probeOrCached(input: DetectInput): {
  backend: LlamaBackend;
  cached: boolean;
  reason: string;
  probedAt: string;
  vendorHint?: GpuVendorHint;
} {
  // The hardware/driver probe is overridable for tests. The cache
  // file lives on real disk regardless, so cache I/O always uses
  // the real fs — otherwise tests that mock `probe.fileExists`
  // would never see their own written cache.
  const probeFile = input.probe?.fileExists ?? fileExistsDefault;
  const probeCmd = input.probe?.commandOk ?? commandOkDefault;
  const probeReadFile = input.probe?.readFileText ?? readFileTextDefault;
  const probeReadDir = input.probe?.readDir ?? readDirDefault;
  const cachePath = join(input.home, 'engines', 'llama-cpp', 'backend.json');

  // ── Cache check (always real fs) ───────────────────────────────
  // Two gates: the engineVersion has to match (probe results may
  // shift across llama.cpp pins), AND the probeSchemaVersion has to
  // be current (probe *logic* may have broadened since the cache
  // was written — see PROBE_SCHEMA_VERSION). Either gate failing
  // forces a re-probe.
  if (fileExistsDefault(cachePath)) {
    try {
      const cached: CacheFile = JSON.parse(readFileSync(cachePath, 'utf8'));
      const schemaOk = (cached.probeSchemaVersion ?? 0) >= PROBE_SCHEMA_VERSION;
      if (cached.engineVersion === input.engineVersion && schemaOk) {
        return {
          backend: cached.backend,
          cached: true,
          reason: `cached: ${cached.reason}`,
          probedAt: cached.probedAt,
          ...(cached.vendorHint ? { vendorHint: cached.vendorHint } : {}),
        };
      }
      // engineVersion changed, or the cache was written by an older
      // probe — fall through and re-probe.
    } catch {
      // Corrupt cache — re-probe.
    }
  }

  // ── Platform dispatch ─────────────────────────────────────────
  const plat = input.probe?.platform ?? nodePlatform;
  const ar = input.probe?.arch ?? nodeArch;
  let result: { backend: LlamaBackend; reason: string; vendorHint?: GpuVendorHint };

  if (plat === 'darwin') {
    if (ar === 'arm64') {
      result = { backend: 'metal', reason: 'Apple Silicon — Metal always available' };
    } else {
      // We don't ship Intel-Mac variants of llama-server, but if
      // someone runs Gezel on one, fall back to CPU rather than
      // erroring — the bundled llama-server-cpu binary covers it.
      result = { backend: 'cpu', reason: 'Intel Mac — no Metal path, using CPU' };
    }
  } else if (plat === 'linux' && (ar === 'x64' || ar === 'arm64')) {
    // arm64 hosts (Jetson, DGX Spark, Grace Hopper) get the same
    // CUDA → Vulkan → CPU probe as x64. Vulkan is rare on arm64
    // today (no LunarG aarch64 SDK) but the probe is correct either
    // way; if the loader is present we'll try Vulkan and fail
    // through to CPU on launch error.
    result = detectLinuxOrWin('linux', probeFile, probeCmd, probeReadFile, probeReadDir);
  } else if (plat === 'win32' && ar === 'x64') {
    result = detectLinuxOrWin('win32', probeFile, probeCmd, probeReadFile, probeReadDir);
  } else {
    result = { backend: 'cpu', reason: `unsupported platform ${plat}/${ar} — CPU only` };
  }

  const probedAt = new Date().toISOString();

  // ── Persist ───────────────────────────────────────────────────
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    const payload: CacheFile = {
      probeSchemaVersion: PROBE_SCHEMA_VERSION,
      engineVersion: input.engineVersion,
      backend: result.backend,
      reason: result.reason,
      probedAt,
      ...(result.vendorHint ? { vendorHint: result.vendorHint } : {}),
    };
    writeFileSync(cachePath, JSON.stringify(payload, null, 2));
  } catch {
    // Non-fatal — detection runs again next launch. A read-only
    // GEZEL_HOME is an unsupported configuration anyway.
  }

  return {
    backend: result.backend,
    cached: false,
    reason: result.reason,
    probedAt,
    ...(result.vendorHint ? { vendorHint: result.vendorHint } : {}),
  };
}
