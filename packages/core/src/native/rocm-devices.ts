/**
 * Can the bundled ROCm build of llama-server drive a GPU on this machine,
 * and which ones?
 *
 * A Vulkan or CUDA build carries code that runs on every GPU its driver
 * accepts. A ROCm build does not: it carries compiled kernels for a fixed
 * list of GPU architectures (`rocmTargets` in `gezel-llama-build.json`), and
 * the HIP runtime enumerates every AMD GPU regardless. Three things follow,
 * and each one decided this module's shape:
 *
 * - An AMD driver is not evidence that ROCm will work. A Radeon older than
 *   the target list, or a desktop whose only AMD GPU is the Ryzen's small
 *   integrated one, would start the ROCm build and crash on its first kernel
 *   (or quietly run on the CPU). So the backend probe's `rocm` is only a
 *   preference: discovery asks the build itself, here, before choosing it.
 * - The answer comes from the build. Nothing on disk says which architecture
 *   a Windows GPU is, and on Linux the HIP device order is the runtime's to
 *   define. `gezel-llama-server --log-verbosity 4 --list-devices` makes ggml's
 *   HIP backend print `Device 0: AMD Radeon AI PRO R9700, gfx1201 (0x1201), …`
 *   for every GPU it enumerates — the HIP index and architecture in one line.
 *   (At the default verbosity llama-server drops those lines and prints only
 *   the device names, and the flag must come first to apply in time.)
 * - A machine can mix supported and unsupported AMD GPUs (every Ryzen
 *   7000/9000 desktop with a Radeon card). ROCm reports the integrated GPU as
 *   an ordinary GPU, so llama.cpp would split the model onto it. The launch
 *   hides it with `HIP_VISIBLE_DEVICES`, from {@link rocmLaunchEnv}.
 *
 * The probe spawns the engine binary, so its answer is cached beside the
 * backend cache, keyed by the build's bytes and the AMD driver's, and
 * re-asked only when either changes. It initializes the HIP runtime and
 * enumerates devices; it never loads a model or runs a kernel.
 */

import { spawnSync } from 'node:child_process';
import {
  constants,
  accessSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { windowsHeadlessSpawnOptions } from './console-detach.js';
import { LINUX_AMD_KFD_PATH } from './llama-backend.js';
import { binaryFingerprint } from './llama-quarantine.js';

export interface RocmDevice {
  /** HIP device index, the number `HIP_VISIBLE_DEVICES` takes. */
  index: number;
  name: string;
  /** Base architecture, e.g. `gfx1201` (any `:feature` suffix removed). */
  gfx: string;
}

export type RocmBlockerKind =
  /** The HIP runtime found GPUs, none of them an architecture the build carries. */
  | 'no-supported-gpu'
  /** Linux: `/dev/kfd` exists but this account cannot open it. */
  | 'no-device-access'
  /** The build did not answer: it crashed, hung, or found no GPU at all. */
  | 'probe-failed';

export interface RocmBlocker {
  kind: RocmBlockerKind;
  /** Technical explanation, for a "Technical details" disclosure. */
  detail: string;
}

export interface RocmCheck {
  blocker: RocmBlocker | null;
  /** Every GPU the HIP runtime enumerated, in HIP order. Empty when unknown. */
  devices: RocmDevice[];
  /**
   * Indices of the GPUs to keep visible, or null to leave HIP's default (every
   * device the build supports was already visible).
   */
  visibleDevices: number[] | null;
}

/**
 * The GPU architectures the released ROCm builds carry kernels for: RDNA3
 * (Radeon RX 7000 / Pro W7000, `gfx1100`–`gfx1102`), the Radeon 780M/760M
 * integrated GPUs (`gfx1103`), Strix Point and Strix Halo (`gfx1150`,
 * `gfx1151`), and RDNA4 (Radeon RX 9000 / AI PRO R9700, `gfx1200`,
 * `gfx1201`). Every target costs ~60 MB on disk, so older parts stay on
 * Vulkan, which serves them well. The build's own `rocmTargets` are what a
 * launch trusts; this list exists to decide before a download, and
 * `build-native.yml`'s `rocm_gpu_targets` must equal it (native-payload.test.mjs).
 */
export const ROCM_GFX_TARGETS: readonly string[] = Object.freeze([
  'gfx1100',
  'gfx1101',
  'gfx1102',
  'gfx1103',
  'gfx1150',
  'gfx1151',
  'gfx1200',
  'gfx1201',
]);

/** The architecture name for a KFD `gfx_target_version` (`120001` → `gfx1201`). Pure. */
export function gfxFromTargetVersion(version: number): string | null {
  if (!Number.isInteger(version) || version <= 0) return null;
  const major = Math.floor(version / 10000);
  const minor = Math.floor(version / 100) % 100;
  const stepping = version % 100;
  return `gfx${major}${minor.toString(16)}${stepping.toString(16)}`;
}

/**
 * Linux: the GPU architectures the amdgpu driver's KFD topology lists, without
 * spawning anything. CPU nodes report version 0 and are skipped. Empty when the
 * topology cannot be read.
 */
export function linuxKfdGfxTargets(
  io: { readFile?: (path: string) => string; listDir?: (path: string) => string[] } = {},
): string[] {
  const readFile = io.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const listDir = io.listDir ?? ((path: string) => readdirSync(path));
  const root = '/sys/class/kfd/kfd/topology/nodes';
  const found: string[] = [];
  let nodes: string[];
  try {
    nodes = listDir(root);
  } catch {
    return found;
  }
  for (const node of nodes) {
    try {
      const match = /gfx_target_version\s+(\d+)/.exec(readFile(`${root}/${node}/properties`));
      const gfx = match?.[1] ? gfxFromTargetVersion(Number(match[1])) : null;
      if (gfx) found.push(gfx);
    } catch {
      // A node that cannot be read says nothing.
    }
  }
  return found;
}

/**
 * Whether an on-demand install should download the ROCm build of llama-server
 * for this machine, deciding before a download of several hundred megabytes.
 *
 * Linux can answer from the KFD topology. Windows cannot — no file names a
 * Radeon's architecture — so on-demand installs there take Vulkan unless the
 * person pins ROCm. The desktop app bundles both builds and asks the ROCm
 * build itself at discovery ({@link checkRocmBuild}), so it needs no guess.
 */
export function rocmWorthDownloading(
  io: {
    platform?: NodeJS.Platform;
    readFile?: (path: string) => string;
    listDir?: (path: string) => string[];
    canOpen?: (path: string) => boolean;
  } = {},
): boolean {
  if ((io.platform ?? process.platform) !== 'linux') return false;
  if (!(io.canOpen ?? canOpenDefault)(LINUX_AMD_KFD_PATH)) return false;
  return linuxKfdGfxTargets(io).some((gfx) => ROCM_GFX_TARGETS.includes(gfx));
}

/** JSON `RocmBlocker`, set by discovery when the ROCm build was passed over. */
export const LLAMA_ROCM_BLOCKER_ENV = 'GEZEL_LLAMA_ROCM_BLOCKER';

/**
 * Directory beside the ROCm build holding its per-architecture rocBLAS kernel
 * packs. rocBLAS looks for them at `../.kpack/` relative to its own library,
 * which would be outside the variant directory, so the launch names each file
 * through `ROCM_KPACK_PATH_PREFIX` instead.
 */
export const ROCM_KPACK_DIR = 'kpack';

/** With or without llama-server's `0.00.043.005 I ` log prefix. */
const DEVICE_LINE =
  /^(?:\d+\.\d+\.\d+\.\d+ [A-Z] )?\s*Device (\d+): (.+?), (gfx[0-9a-f]+)(?::[^\s,(]*)? \(0x[0-9a-f]+\)/i;

/** The GPUs ggml's HIP backend listed while initializing. Pure. */
export function parseRocmDeviceLog(text: string): RocmDevice[] {
  const devices: RocmDevice[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = DEVICE_LINE.exec(line);
    if (!match?.[1] || !match[2] || !match[3]) continue;
    devices.push({ index: Number(match[1]), name: match[2].trim(), gfx: match[3].toLowerCase() });
  }
  return devices;
}

/** The architectures the build at `binaryPath` carries kernels for, or null when it does not say. */
export function rocmBuildTargets(
  binaryPath: string,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string[] | null {
  try {
    const parsed = JSON.parse(readFile(join(dirname(binaryPath), 'gezel-llama-build.json'))) as {
      rocmTargets?: unknown;
    };
    const targets = parsed.rocmTargets;
    if (!Array.isArray(targets) || !targets.every((t) => typeof t === 'string')) return null;
    return targets.map((t) => t.toLowerCase());
  } catch {
    return null;
  }
}

/**
 * Decide from a device listing. `targets` null means the build did not record
 * its list (a local build without the metadata); every device then counts.
 */
export function rocmCheckFromDevices(
  devices: readonly RocmDevice[],
  targets: readonly string[] | null,
): RocmCheck {
  if (devices.length === 0) {
    return {
      blocker: { kind: 'probe-failed', detail: 'the ROCm build found no AMD GPU it could open' },
      devices: [],
      visibleDevices: null,
    };
  }
  const supported = targets ? devices.filter((d) => targets.includes(d.gfx)) : [...devices];
  if (supported.length === 0) {
    const found = devices.map((d) => `${d.name} (${d.gfx})`).join(', ');
    return {
      blocker: {
        kind: 'no-supported-gpu',
        detail: `the ROCm build has no code for ${found}; it supports ${targets?.join(', ')}`,
      },
      devices: [...devices],
      visibleDevices: null,
    };
  }
  return {
    blocker: null,
    devices: [...devices],
    visibleDevices: supported.length === devices.length ? null : supported.map((d) => d.index),
  };
}

/** The kernel packs shipped beside a ROCm build, as absolute paths. */
export function rocmKpackFiles(
  binDir: string,
  listDir: (path: string) => string[] = (path) => readdirSync(path),
): string[] {
  try {
    return listDir(join(binDir, ROCM_KPACK_DIR))
      .filter((name) => name.endsWith('.kpack'))
      .sort()
      .map((name) => join(binDir, ROCM_KPACK_DIR, name));
  } catch {
    return [];
  }
}

/**
 * Environment a ROCm build of llama-server needs, for its launch and for
 * every probe that loads its HIP backend (`--list-devices`):
 *
 * - `ROCM_KPACK_PATH_PREFIX` — the bundled rocBLAS kernel packs (see
 *   {@link ROCM_KPACK_DIR}). Prepended to anything already set.
 * - `ROCBLAS_USE_HIPBLASLT=0` — rocBLAS otherwise routes some matrix shapes
 *   through hipBLASLt, whose kernel library is ~170 MB per GPU architecture
 *   and is not bundled. Measured cost on a Radeon AI PRO R9700: ~3.5% prompt
 *   reading, nothing on generation. An operator's own setting wins.
 * - `HIP_VISIBLE_DEVICES` — when given, the GPUs to keep (see the module
 *   docstring). An operator's own setting wins.
 */
export function rocmEngineEnv(
  binDir: string,
  visibleDevices: readonly number[] | null,
  inherited: NodeJS.ProcessEnv = process.env,
  listDir?: (path: string) => string[],
): Record<string, string> {
  const env: Record<string, string> = {};
  const kpacks = rocmKpackFiles(binDir, listDir);
  if (kpacks.length > 0) {
    const prior = inherited.ROCM_KPACK_PATH_PREFIX;
    env.ROCM_KPACK_PATH_PREFIX = [...kpacks, ...(prior ? [prior] : [])].join(delimiter);
  }
  if (inherited.ROCBLAS_USE_HIPBLASLT === undefined) env.ROCBLAS_USE_HIPBLASLT = '0';
  if (visibleDevices && inherited.HIP_VISIBLE_DEVICES === undefined) {
    env.HIP_VISIBLE_DEVICES = visibleDevices.join(',');
  }
  return env;
}

/** Stamp (or clear) why discovery passed the ROCm build over, for the engine process to report. */
export function publishRocmCheck(
  check: RocmCheck | null,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (check?.blocker) env[LLAMA_ROCM_BLOCKER_ENV] = JSON.stringify(check.blocker);
  else delete env[LLAMA_ROCM_BLOCKER_ENV];
}

const BLOCKER_KINDS = new Set<string>(['no-supported-gpu', 'no-device-access', 'probe-failed']);

/** The blocker discovery published, or null for none or a malformed value. */
export function readRocmBlocker(env: NodeJS.ProcessEnv = process.env): RocmBlocker | null {
  const raw = env[LLAMA_ROCM_BLOCKER_ENV];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RocmBlocker>;
    if (typeof parsed.kind !== 'string' || !BLOCKER_KINDS.has(parsed.kind)) return null;
    if (typeof parsed.detail !== 'string') return null;
    return { kind: parsed.kind as RocmBlockerKind, detail: parsed.detail };
  } catch {
    return null;
  }
}

// ── Probe + cache ─────────────────────────────────────────────────────

/** Injection seam — tests supply fakes, production uses the host. */
export interface RocmProbeIo {
  platform?: NodeJS.Platform;
  readFile?: (path: string) => string;
  writeFile?: (path: string, data: string) => void;
  listDir?: (path: string) => string[];
  /** Whether this account can open `path` for reading and writing. */
  canOpen?: (path: string) => boolean;
  fingerprint?: (path: string) => string | null;
  /** Run the build's `--list-devices`; returns combined output, or null when it failed. */
  listDevices?: (binaryPath: string, env: NodeJS.ProcessEnv) => string | null;
  now?: () => Date;
}

interface CacheFile {
  schemaVersion: 1;
  /** Fingerprints of the build and the AMD driver the answer was probed with. */
  key: string;
  check: RocmCheck;
  probedAt: string;
}

/** A failed probe is retried after this long even when nothing changed. */
const PROBE_FAILED_RETRY_MS = 24 * 60 * 60 * 1000;
const LIST_DEVICES_TIMEOUT_MS = 30_000;

export function rocmDeviceCachePath(home: string): string {
  return join(home, 'engines', 'llama-cpp', 'rocm-devices.json');
}

function windowsSystem32(): string {
  return process.env.SYSTEMROOT
    ? join(process.env.SYSTEMROOT, 'System32')
    : 'C:\\Windows\\System32';
}

/**
 * What identifies the AMD driver a cached answer was probed against: the
 * user-mode driver library on Windows (a driver update replaces it), the KFD
 * topology's GPU nodes on Linux (a card added or removed changes it).
 */
function driverKey(
  io: Required<Pick<RocmProbeIo, 'platform' | 'readFile' | 'listDir' | 'fingerprint'>>,
): string {
  if (io.platform === 'win32') {
    const sys32 = windowsSystem32();
    return ['amdxc64.dll', 'aticfx64.dll', 'amdhip64_7.dll']
      .map((dll) => `${dll}=${io.fingerprint(join(sys32, dll)) ?? '-'}`)
      .join(';');
  }
  const root = '/sys/class/kfd/kfd/topology/nodes';
  let nodes: string[] = [];
  try {
    nodes = io.listDir(root).sort();
  } catch {
    return 'kfd=-';
  }
  return nodes
    .map((node) => {
      try {
        const match = /gfx_target_version\s+(\d+)/.exec(io.readFile(`${root}/${node}/properties`));
        return `${node}=${match?.[1] ?? '?'}`;
      } catch {
        return `${node}=?`;
      }
    })
    .join(';');
}

function canOpenDefault(path: string): boolean {
  try {
    accessSync(path, constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function listDevicesDefault(binaryPath: string, env: NodeJS.ProcessEnv): string | null {
  const result = spawnSync(binaryPath, ['--log-verbosity', '4', '--list-devices'], {
    env,
    encoding: 'utf8',
    timeout: LIST_DEVICES_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    ...windowsHeadlessSpawnOptions(),
  });
  if (result.error || result.status !== 0) return null;
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

/**
 * Whether the ROCm build at `binaryPath` can drive a GPU here, probing the
 * build once per build-and-driver and caching the answer under `home`.
 */
export function checkRocmBuild(home: string, binaryPath: string, io: RocmProbeIo = {}): RocmCheck {
  const platform = io.platform ?? process.platform;
  const readFile = io.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const listDir = io.listDir ?? ((path: string) => readdirSync(path));
  const fingerprint = io.fingerprint ?? ((path: string) => binaryFingerprint(path));
  const canOpen = io.canOpen ?? canOpenDefault;
  const now = io.now?.() ?? new Date();

  // Linux: the ROCm runtime opens /dev/kfd for every device. Without access
  // it finds nothing and the build would run on the CPU; say why instead.
  if (platform === 'linux' && !canOpen(LINUX_AMD_KFD_PATH)) {
    return {
      blocker: {
        kind: 'no-device-access',
        detail: `${LINUX_AMD_KFD_PATH} is not readable and writable by this account; add it to the "render" and "video" groups`,
      },
      devices: [],
      visibleDevices: null,
    };
  }

  const key = `${fingerprint(binaryPath) ?? binaryPath}|${driverKey({ platform, readFile, listDir, fingerprint })}`;
  const cachePath = rocmDeviceCachePath(home);
  try {
    const cached = JSON.parse(readFile(cachePath)) as Partial<CacheFile>;
    const fresh =
      cached.schemaVersion === 1 &&
      cached.key === key &&
      cached.check &&
      typeof cached.probedAt === 'string' &&
      !(
        cached.check.blocker?.kind === 'probe-failed' &&
        now.getTime() - Date.parse(cached.probedAt) >= PROBE_FAILED_RETRY_MS
      );
    if (fresh && cached.check) return cached.check;
  } catch {
    // Missing or unreadable — probe.
  }

  const binDir = dirname(binaryPath);
  const inheritedPath = process.env.PATH ?? '';
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: inheritedPath ? `${binDir}${delimiter}${inheritedPath}` : binDir,
    ...rocmEngineEnv(binDir, null, process.env, listDir),
  };
  // The probe must see every GPU, so an inherited filter cannot narrow it.
  delete env.HIP_VISIBLE_DEVICES;
  const output = (io.listDevices ?? listDevicesDefault)(binaryPath, env);
  const check =
    output === null
      ? {
          blocker: {
            kind: 'probe-failed' as const,
            detail: `${binaryPath} --list-devices failed or timed out`,
          },
          devices: [],
          visibleDevices: null,
        }
      : rocmCheckFromDevices(parseRocmDeviceLog(output), rocmBuildTargets(binaryPath, readFile));

  const writeFile =
    io.writeFile ?? ((path: string, data: string) => writeFileSync(path, data, 'utf8'));
  try {
    if (!io.writeFile) mkdirSync(dirname(cachePath), { recursive: true });
    const file: CacheFile = { schemaVersion: 1, key, check, probedAt: now.toISOString() };
    writeFile(cachePath, `${JSON.stringify(file, null, 2)}\n`);
  } catch {
    // Best-effort: the probe runs again next time.
  }
  return check;
}

/**
 * The launch environment for the llama-server at `binaryPath`: the ROCm
 * variables when it is a ROCm build (`backend`, or `rocmTargets` in its build
 * metadata), nothing otherwise. Reads the cached device check, which
 * discovery has normally written already, so this is a file read.
 */
export function rocmLaunchEnv(
  home: string,
  binaryPath: string,
  backend?: string,
  io: RocmProbeIo = {},
): Record<string, string> {
  const isRocm =
    backend === 'rocm' ||
    (backend === undefined && rocmBuildTargets(binaryPath, io.readFile) !== null);
  if (!isRocm) return {};
  const check = checkRocmBuild(home, binaryPath, io);
  return rocmEngineEnv(
    dirname(binaryPath),
    check.blocker ? null : check.visibleDevices,
    process.env,
    io.listDir,
  );
}
