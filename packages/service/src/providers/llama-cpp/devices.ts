/**
 * Device (VRAM) probe for the bundled `llama-server`.
 *
 * b9843's `--list-devices` prints one line per backend device with its
 * total + free memory, e.g.
 *
 *   Available devices:
 *     CUDA0: NVIDIA GeForce RTX 4070 (12282 MiB, 11987 MiB free)
 *     MTL0: Apple M4 Max (53084 MiB, 53083 MiB free)
 *     BLAS: Accelerate (0 MiB, 0 MiB free)
 *
 * That's the ground-truth VRAM number we need for the MoE offload
 * planner — no native NVML/DXGI/Metal binding required. We spawn it
 * once and cache the result next to the backend cache
 * (`<home>/engines/llama-cpp/devices.json`), mirroring the
 * `backend.json` pattern in `core/native/llama-backend.ts`.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { windowsDetachedSpawnOptions } from '@bendyline/gezel/native';
import { gezelHome } from '@bendyline/gezel/paths';

const execFileAsync = promisify(execFile);

export interface LlamaDevice {
  /** Backend device id, e.g. `CUDA0`, `Vulkan0`, `MTL0`, `BLAS`. */
  id: string;
  /** Human name, e.g. `NVIDIA GeForce RTX 4070`. */
  name: string;
  /** Total device memory in MiB. */
  totalMiB: number;
  /** Free device memory in MiB at probe time. */
  freeMiB: number;
}

export interface LlamaDeviceProbe {
  devices: LlamaDevice[];
  /** ISO timestamp the probe ran (or was cached). */
  probedAt: string;
  /** True when returned from the on-disk cache rather than a fresh spawn. */
  cached: boolean;
}

export interface NvidiaRuntimeDevice {
  index: number;
  name: string;
  computeCapability: string;
  driverVersion: string;
}

const LINE_RE = /^\s*(\S+?):\s*(.+?)\s*\((\d+)\s*MiB,\s*(\d+)\s*MiB\s+free\)\s*$/;

/**
 * Parse `--list-devices` stdout into structured device records. Pure —
 * the unit-tested half of the probe. Lines that don't match the
 * `id: name (N MiB, M MiB free)` shape (the `Available devices:` header,
 * blank lines, log noise) are ignored.
 */
export function parseLlamaDevices(stdout: string): LlamaDevice[] {
  const devices: LlamaDevice[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const [, id, name, total, free] = m;
    devices.push({
      id: id as string,
      name: (name as string).trim(),
      totalMiB: Number(total),
      freeMiB: Number(free),
    });
  }
  return devices;
}

/** Parse the stable CSV shape requested from nvidia-smi for crash diagnostics. */
export function parseNvidiaRuntimeDevices(stdout: string): NvidiaRuntimeDevice[] {
  const devices: NvidiaRuntimeDevice[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const fields = rawLine.split(',').map((field) => field.trim());
    if (fields.length !== 4) continue;
    const index = Number.parseInt(fields[0] ?? '', 10);
    const name = fields[1] ?? '';
    const computeCapability = fields[2] ?? '';
    const driverVersion = fields[3] ?? '';
    if (!Number.isFinite(index) || !name || !computeCapability || !driverVersion) continue;
    devices.push({ index, name, computeCapability, driverVersion });
  }
  return devices;
}

/**
 * Best-effort NVIDIA driver/device facts. This is diagnostic only: failure or
 * absence never changes backend selection and returns an empty list.
 */
export async function probeNvidiaRuntimeDevices(): Promise<NvidiaRuntimeDevice[]> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=index,name,compute_cap,driver_version', '--format=csv,noheader,nounits'],
      { timeout: 5_000, ...windowsDetachedSpawnOptions() },
    );
    return parseNvidiaRuntimeDevices(stdout);
  } catch {
    return [];
  }
}

/** Match llama-server's selected CUDA device to nvidia-smi diagnostics. */
export function matchNvidiaRuntimeDevice(
  llamaDevice: LlamaDevice | null,
  nvidiaDevices: NvidiaRuntimeDevice[],
): NvidiaRuntimeDevice | undefined {
  const cudaIndex = llamaDevice?.id.match(/^CUDA(\d+)$/i)?.[1];
  return (
    (cudaIndex !== undefined
      ? nvidiaDevices.find((device) => device.index === Number(cudaIndex))
      : undefined) ??
    (llamaDevice ? nvidiaDevices.find((device) => device.name === llamaDevice.name) : undefined) ??
    nvidiaDevices[0]
  );
}

/**
 * The largest single-device VRAM pool, in BYTES. Excludes the CPU/BLAS
 * pseudo-devices (which report 0 MiB). Returns 0 when there's no GPU
 * device — the planner reads that as "no offload target, leave it to
 * the engine". We use the max (not the sum) because a model loads onto
 * one device by default; multi-GPU splitting is a separate knob.
 */
export function maxGpuVramBytes(devices: LlamaDevice[]): number {
  let maxMiB = 0;
  for (const d of devices) {
    if (d.totalMiB > maxMiB) maxMiB = d.totalMiB;
  }
  return maxMiB * 1024 * 1024;
}

/**
 * The largest real GPU device (by total memory), or null when the list
 * holds only CPU/BLAS pseudo-devices (which report 0 MiB). Same selection
 * as `maxGpuVramBytes`, but returns the device so callers can name the card
 * (e.g. "AMD Radeon RX 7900 XTX") in a tier rationale. Pure — unit-tested.
 */
export function pickBestGpuDevice(devices: LlamaDevice[]): LlamaDevice | null {
  const dedicated = devices.filter(
    (device) => device.totalMiB > 0 && gpuMemoryKindFromName(device.name) === 'discrete',
  );
  // An iGPU can advertise a larger shared allocation than a real card's
  // dedicated VRAM. Prefer a known discrete device first so a 16-GiB shared
  // Intel heap cannot hide a 12-GiB Radeon board.
  const candidates = dedicated.length > 0 ? dedicated : devices;
  let best: LlamaDevice | null = null;
  for (const d of candidates) {
    if (d.totalMiB > 0 && (!best || d.totalMiB > best.totalMiB)) best = d;
  }
  return best;
}

function cachePath(home: string): string {
  return join(home, 'engines', 'llama-cpp', 'devices.json');
}

/**
 * Probe device memory by running `<binaryPath> --list-devices`, caching
 * the result. Reads the cache when present (VRAM capacity is stable per
 * machine); pass `force` to re-probe. Any failure (spawn error, no
 * cache, unparseable output) resolves to an empty device list — the
 * planner then simply does nothing and the engine's own `--fit`/`-ngl
 * auto` takes over. `nowIso` is injectable for deterministic tests.
 */
export async function probeLlamaDevices(opts: {
  binaryPath: string;
  home: string;
  force?: boolean;
  nowIso?: () => string;
}): Promise<LlamaDeviceProbe> {
  const { binaryPath, home, force } = opts;
  const now = opts.nowIso ?? (() => new Date().toISOString());
  const path = cachePath(home);

  if (!force && existsSync(path)) {
    try {
      const cached = JSON.parse(readFileSync(path, 'utf8')) as LlamaDeviceProbe;
      if (Array.isArray(cached.devices)) return { ...cached, cached: true };
    } catch {
      // fall through to a fresh probe
    }
  }

  let devices: LlamaDevice[] = [];
  try {
    // Prepend the binary's dir to PATH so its peer GGML/CUDA DLLs
    // resolve on Windows (same reason the launcher does it).
    const binDir = dirname(binaryPath);
    const inheritedPath = process.env.PATH ?? '';
    const { stdout } = await execFileAsync(binaryPath, ['--list-devices'], {
      timeout: 20_000,
      env: {
        ...process.env,
        PATH: inheritedPath ? `${binDir}${delimiter}${inheritedPath}` : binDir,
      },
      // Same engine binary the supervisor launches, so the same rule: no
      // console under the machine service's restricted SID, or this probe
      // fails and VRAM reads as unknown.
      ...windowsDetachedSpawnOptions(),
    });
    devices = parseLlamaDevices(stdout);
  } catch {
    // Leave devices empty — caller treats "no devices" as "no offload target".
    return { devices, probedAt: now(), cached: false };
  }

  const probe: LlamaDeviceProbe = { devices, probedAt: now(), cached: false };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(probe, null, 2), 'utf8');
  } catch {
    // Caching is best-effort; a write failure doesn't invalidate the probe.
  }
  return probe;
}

/**
 * Best-effort VRAM for a non-NVIDIA GPU (AMD Radeon, Intel Arc, any Vulkan
 * device) via the bundled `llama-server --list-devices` — the one VRAM
 * source in the tree that isn't `nvidia-smi`. Returns null when the engine
 * binary isn't resolved yet (`GEZEL_LLAMA_SERVER_BIN` unset — e.g. a
 * standalone gezeld before its first engine launch) or no GPU is reported.
 * The underlying probe caches to `devices.json`, so this spawns at most
 * once per host.
 *
 * `detectMemoryProfile` and `detectModelTier` call this AFTER `nvidia-smi`
 * misses, so a Radeon box gets a real GPU budget + model tier instead of
 * falling through to the nvidia-only "no GPU detected → system RAM" path.
 */
export type GpuVendor = 'amd' | 'nvidia' | 'intel';
export type LlamaGpuMemoryKind = 'discrete' | 'integrated' | 'unknown';

/**
 * Infer the GPU vendor from the device NAME `--list-devices` reports (e.g.
 * "AMD Radeon AI PRO R9700", "Intel(R) Arc(TM) A770 Graphics", "NVIDIA
 * GeForce RTX 4070"). Deriving it from the same string that named the card
 * — rather than a separate driver-DLL probe — guarantees the label can't
 * disagree with the device whose VRAM we actually picked: an Intel Arc on
 * the Vulkan backend reads "Intel", never "AMD". Unknown or software
 * devices (llvmpipe, SwiftShader, …) return undefined, and the caller shows
 * a generic "GPU" rather than guessing a brand. Pure — unit-tested.
 */
export function gpuVendorFromName(name: string): GpuVendor | undefined {
  const n = name.toLowerCase();
  if (n.includes('nvidia') || n.includes('geforce') || n.includes('rtx')) return 'nvidia';
  if (n.includes('amd') || n.includes('radeon')) return 'amd';
  if (n.includes('intel') || n.includes('arc')) return 'intel';
  return undefined;
}

/**
 * Best-effort classification of the memory reported by llama.cpp's Vulkan
 * device probe. Integrated adapters commonly expose a large slice of system
 * RAM as their `totalMiB`; treating that number as dedicated VRAM counts the
 * same physical memory twice.
 *
 * Names intentionally identify only strong, well-known families. Unknown
 * hardware keeps the historical behavior rather than being silently demoted.
 * Intel is the useful exception: consumer Intel Graphics/UHD/Iris adapters
 * are integrated unless the name carries a discrete Arc board SKU (A770,
 * B580, Pro A60, etc.).
 */
export function gpuMemoryKindFromName(name: string): LlamaGpuMemoryKind {
  const n = name.toLowerCase().replaceAll('(tm)', ' ').replaceAll('(r)', ' ');

  if (n.includes('qualcomm') || n.includes('adreno')) return 'integrated';

  if (n.includes('intel')) {
    // Discrete Intel Arc boards include a letter+number SKU. Plain "Intel Arc
    // Graphics" is the integrated Meteor/Lunar Lake branding.
    if (/\barc\b.*\b(?:pro\s+)?[ab]\d{2,4}\b/.test(n)) return 'discrete';
    return 'integrated';
  }

  if (n.includes('amd') || n.includes('radeon')) {
    if (
      /\bradeon\s+(?:rx\s*\d|vii\b|pro\s+w\d|ai\s+pro\b)/.test(n) ||
      /\b(?:instinct|firepro)\b/.test(n)
    ) {
      return 'discrete';
    }
    if (
      /\b(?:vega|radeon\s+graphics)\b/.test(n) ||
      /\bradeon\s+\d{3,4}[ms]\b/.test(n)
    ) {
      return 'integrated';
    }
  }

  if (n.includes('nvidia') || n.includes('geforce') || n.includes('quadro')) {
    return 'discrete';
  }
  return 'unknown';
}

export async function detectLlamaGpuVram(
  homeOverride?: string,
): Promise<{
  vramBytes: number;
  name: string;
  vendor?: GpuVendor;
  memoryKind: LlamaGpuMemoryKind;
} | null> {
  const binaryPath = process.env.GEZEL_LLAMA_SERVER_BIN;
  if (!binaryPath) return null;
  try {
    const home = homeOverride ?? gezelHome();
    const probe = await probeLlamaDevices({ binaryPath, home });
    const best = pickBestGpuDevice(probe.devices);
    if (!best) return null;
    const vendor = gpuVendorFromName(best.name);
    return {
      vramBytes: best.totalMiB * 1024 * 1024,
      name: best.name,
      memoryKind: gpuMemoryKindFromName(best.name),
      ...(vendor ? { vendor } : {}),
    };
  } catch {
    return null;
  }
}
