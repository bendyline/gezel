import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { homedir, totalmem } from 'node:os';
import { join } from 'node:path';
import {
  GEZEL_VERSION,
  type NativeCapacityCommand,
  NativeCapacityCommandSchema,
  type NativeCapacityReply,
  NativeCapacityReplySchema,
  awakeNow,
  createLogger,
  isUnstampedDevBuild,
} from '@bendyline/gezel';
import { readSystemServiceRuntime, systemServiceHome } from '@bendyline/gezel-client/node';
import { ConfigStore } from '../../fs/config-store.js';
import { createPinnedFetch } from '../../remotes/pinned-fetch.js';
import {
  CapacityDeniedError,
  availableSystemRamBytes,
  liveRamOsReserveBytes,
} from './capacity-broker.js';
import { DeviceCapacityLedger, type DeviceCapacitySample } from './device-capacity-ledger.js';
import { measuredCapacityBudget } from './measured-budget.js';
import type { NativeEngineLaunch } from './supervisor.js';

const GIB = 1024 ** 3;
const POLL_MS = 500;
const WAIT_MS = 5 * 60_000;
/**
 * Ceiling for the case where the ledger reports `externalShortfall` — the
 * request leads the queue and fits the budget, and nothing this protocol
 * governs is holding the memory. Queueing behind another engine is worth the
 * full {@link WAIT_MS}, because that engine will finish. Queueing behind the
 * user's browser is not: a request that needs 9.7 GB on a host with 4.3 GB
 * free waits out the entire budget and then reports "not enough memory became
 * available" — five minutes to say what was knowable in the first second.
 * Short rather than zero because a just-released engine's pages take a moment
 * to come back, and makeRoom's retry deserves to see them.
 */
const EXTERNAL_SHORTFALL_WAIT_MS = 20_000;
// Once an installed broker owns this process's reservations, its disappearance
// is an outage, never permission to create a competing local ledger.
const observedMachineAuthorities = new Set<string>();
const log = createLogger('native-capacity');
/** Skew is announced once per (broker home, version) — acquire runs per launch. */
const announcedSkew = new Set<string>();

export interface BrokerVersionSkew {
  /** What the installed machine engine reports, or `'unknown'` if it reports none. */
  brokerVersion: string;
  localVersion: string;
  /**
   * Take the LOCAL ledger instead of deferring. True only for an unstamped
   * dev build facing a broker that is not the same build.
   */
  takeLocalAuthority: boolean;
}

/**
 * Decide who arbitrates this machine's memory when an installed machine engine
 * is present.
 *
 * Hosting mode does not answer this. An embedded dev daemon still shares the
 * physical RAM of the box with whatever the installed app loads, so deferring
 * to one machine-wide ledger is right in production and right for two builds
 * of the same version. What it is NOT right for is a dev loop: on 2026-09-08 a
 * patched dev build planned an 8.6 GB launch against its own corrected
 * availability reading, handed the request to an installed 1.26251.69 broker
 * whose formula saw 5.9 GB, and waited out the full five-minute admission
 * budget — the fix under test could not run, because the process that decides
 * was a different, older one. Nothing in either log said so.
 *
 * Ordering is deliberately not the test. `isUnstampedDevBuild` is: a checkout
 * carries code no release has, while `0.0.0` sorts below every stamped version
 * — so `compareGezelVersions` would conclude the exact opposite of the truth.
 */
export function assessBrokerVersionSkew(
  brokerVersion: string | undefined,
  localVersion: string = GEZEL_VERSION,
): BrokerVersionSkew | null {
  if (brokerVersion !== undefined && brokerVersion === localVersion) return null;
  return {
    brokerVersion: brokerVersion ?? 'unknown',
    localVersion,
    // A broker that reports no version cannot be shown to be this build, and a
    // dev loop that silently tests someone else's code is the failure here.
    takeLocalAuthority: isUnstampedDevBuild(localVersion),
  };
}

function announceSkew(machineHome: string, skew: BrokerVersionSkew): void {
  const key = `${machineHome}\u0000${skew.brokerVersion}\u0000${String(skew.takeLocalAuthority)}`;
  if (announcedSkew.has(key)) return;
  announcedSkew.add(key);
  if (skew.takeLocalAuthority) {
    log.warn(
      [
        `dev build (unstamped) differs from the installed machine engine (${skew.brokerVersion}); `,
        'using the LOCAL admission ledger so this build’s own memory decisions are the ones under ',
        'test. Engines started by the installed app are NOT coordinated with — quit it before ',
        'loading large models on a memory-tight host. Set ',
        'GEZEL_NATIVE_CAPACITY_AUTHORITY=machine to defer anyway.',
      ].join(''),
    );
    return;
  }
  log.info(
    [
      `this build (${skew.localVersion}) and the installed machine engine (${skew.brokerVersion}) `,
      'are different versions; deferring to the machine engine as the memory authority, so ',
      'admission decisions come from the installed service rather than from this build.',
    ].join(''),
  );
}

export interface NativeMemoryRequirement {
  bytes: number;
  gpuBytes?: number;
  exclusive?: boolean;
}

export interface NativeCapacityLease {
  bind(pid: number): Promise<void>;
  ready(): Promise<void>;
  release(): Promise<void>;
  shouldYield(): Promise<boolean>;
}

export interface NativeCapacityOptions {
  home: string;
  exclusive?: boolean;
  priority?: () => 'interactive' | 'background';
  /** Evaluated after resolveLaunch, so context/offload recovery is priced anew. */
  requirement?: () =>
    | NativeMemoryRequirement
    | undefined
    | Promise<NativeMemoryRequirement | undefined>;
  execute?: (command: NativeCapacityCommand) => Promise<NativeCapacityReply>;
}

export function nativeCapacityDirectory(home: string): string {
  return (
    process.env.GEZEL_NATIVE_CAPACITY_DIR ??
    (home === systemServiceHome()
      ? join(home, 'native-capacity')
      : join(homedir(), '.gezel', 'runtime', 'native-capacity'))
  );
}

export async function sampleDeviceCapacity(home?: string): Promise<DeviceCapacitySample> {
  const budget = await measuredCapacityBudget();
  const ram = totalmem();
  const config = home ? await new ConfigStore(home).readConfig() : {};
  const configuredBytes =
    typeof config.localEngineMemoryGb === 'number' && config.localEngineMemoryGb > 0
      ? config.localEngineMemoryGb * GIB
      : budget.budgetBytes;
  const budgetBytes = Math.min(configuredBytes, budget.budgetBytes);
  // The ledger's RAM ceiling and the OS's currently reclaimable RAM answer
  // different questions. Checking both catches tenants outside this protocol.
  //
  // This MUST be the same reading the context planner sized the launch
  // against — see liveRamOsReserveBytes. It used to be a darwin-only sample
  // that counted neither inactive nor speculative pages, which made admission
  // roughly 5 GiB stricter than planning on a 16 GiB Mac and refused launches
  // the host could serve.
  const availableBytes =
    Math.max(0, availableSystemRamBytes() - liveRamOsReserveBytes(ram)) + budget.vramBytes;
  let availableGpuBytes: number | undefined;
  if (budget.kind === 'discrete-gpu') {
    const { createSystemDeviceHealthProbe } = await import('@bendyline/gezel/native');
    const probe = await createSystemDeviceHealthProbe({
      helperPath: process.env.GEZEL_DEVICE_HEALTH_BIN,
    }).sample();
    const readings = probe.readings.filter(
      (r) => r.memoryTotalMb !== undefined && r.memoryUsedMb !== undefined,
    );
    if (readings.length > 0)
      availableGpuBytes = Math.max(
        0,
        readings.reduce((sum, r) => sum + r.memoryTotalMb! - r.memoryUsedMb!, 0) * 1024 ** 2 -
          256 * 1024 ** 2,
      );
  }
  return {
    budgetBytes,
    // Keep non-reclaimable accelerator commitments on the conservative curve;
    // a larger RAM budget is not permission to wire the whole machine.
    gpuBudgetBytes: Math.min(
      budgetBytes,
      budget.kind === 'unified' ? Math.min(budget.fastBytes, ram * 0.75) : budget.fastBytes,
    ),
    availableBytes,
    ...(availableGpuBytes !== undefined ? { availableGpuBytes } : {}),
    serializeLoads: process.platform === 'darwin',
  };
}

export function localDeviceCapacity(home: string): DeviceCapacityLedger {
  return new DeviceCapacityLedger({
    directory: nativeCapacityDirectory(home),
    sample: () => sampleDeviceCapacity(home),
  });
}

/** Routes reservations to the installed broker even when eval inference is isolated. */
async function capacityExecutor(
  home: string,
): Promise<(command: NativeCapacityCommand) => Promise<NativeCapacityReply>> {
  // Set only after an explicit desktop-startup choice (or deliberately by an
  // operator). This is not tied to GEZEL_DISABLE_MACHINE_ENGINE: isolated
  // inference normally still shares the installed broker's admission ledger.
  const authority = process.env.GEZEL_NATIVE_CAPACITY_AUTHORITY;
  if (authority === 'local') {
    const ledger = localDeviceCapacity(home);
    return (command) => ledger.execute(command);
  }
  const machineHome = systemServiceHome();
  if (machineHome && machineHome !== home) {
    const runtime = await readSystemServiceRuntime(machineHome);
    if (runtime?.serviceRole === 'machine-engine') {
      const { inspectMachineRuntime } = await import('../../machine-engine/bridge.js');
      let identity: Awaited<ReturnType<typeof inspectMachineRuntime>>;
      try {
        identity = await inspectMachineRuntime(runtime);
      } catch (error) {
        // Seeing the role at all is enough to refuse a competing ledger. A
        // broker that is merely unreachable is an outage, never permission to
        // double-book the machine — so claim the authority before rethrowing.
        observedMachineAuthorities.add(machineHome);
        throw error;
      }
      const skew = assessBrokerVersionSkew(identity.gezelVersion);
      if (skew) announceSkew(machineHome, skew);
      // `machine` is the explicit opt-back-in for a dev build that wants the
      // installed broker's arbitration anyway (two engines, one tight host).
      if (skew?.takeLocalAuthority && authority !== 'machine') {
        const ledger = localDeviceCapacity(home);
        return (command) => ledger.execute(command);
      }
      observedMachineAuthorities.add(machineHome);
      let verifiedCert = runtime.cert;
      return async (command) => {
        // Re-read discovery on each operation: broker restarts rotate both the
        // token and TLS certificate. Never switch a live lease to another ledger.
        const current = await readSystemServiceRuntime(machineHome);
        if (!current || current.serviceRole !== 'machine-engine' || !current.cert) {
          throw new CapacityDeniedError(
            'Waiting for the machine engine to restore memory coordination.',
          );
        }
        if (current.cert !== verifiedCert) {
          const refreshed = await inspectMachineRuntime(current);
          if (refreshed.pinnedIdentityFingerprint !== identity.pinnedIdentityFingerprint)
            throw new CapacityDeniedError('The machine memory coordinator identity changed.');
          verifiedCert = current.cert;
        }
        const fetchImpl = createPinnedFetch(current.cert);
        try {
          const response = await fetchImpl(`${current.baseUrl}/v1/remote/manage/native-capacity`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${current.token}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(command),
            signal: AbortSignal.timeout(5_000),
          });
          if (!response.ok) {
            const detail =
              response.status === 409
                ? ((await response.json().catch(() => null)) as { error?: string } | null)
                : null;
            throw new CapacityDeniedError(
              response.status === 404
                ? 'The installed machine engine needs an update before isolated local engines can share memory safely.'
                : (detail?.error ??
                    `Machine memory coordination unavailable (HTTP ${response.status}).`),
            );
          }
          return NativeCapacityReplySchema.parse(await response.json());
        } finally {
          await fetchImpl.close();
        }
      };
    }
    if (observedMachineAuthorities.has(machineHome))
      throw new CapacityDeniedError(
        'Waiting for the machine engine to restore memory coordination.',
      );
  }
  const ledger = localDeviceCapacity(home);
  return (command) => ledger.execute(command);
}

/** Conservative fallback for media engines that do not expose a launch planner. */
export async function estimateNativeLaunchMemory(
  launch: NativeEngineLaunch,
): Promise<NativeMemoryRequirement> {
  const paths = new Set<string>();
  for (let i = 0; i < launch.args.length - 1; i++) {
    if (
      [
        '--model',
        '-m',
        '--mmproj',
        '--diffusion-model',
        '--vae',
        '--clip_l',
        '--clip_g',
        '--t5xxl',
        '--llm',
        '--model-draft',
      ].includes(launch.args[i]!)
    ) {
      paths.add(launch.args[i + 1]!);
    }
  }
  const weightBytes = async (path: string, depth = 0): Promise<number> => {
    const info = await stat(path);
    if (info.isFile()) return info.size;
    if (!info.isDirectory() || depth > 6) return 0;
    const entries = await readdir(path, { withFileTypes: true });
    let bytes = 0;
    for (const entry of entries) {
      if (
        entry.isDirectory() ||
        (entry.isFile() && /\.(gguf|safetensors|bin|pt|pth)$/i.test(entry.name))
      ) {
        bytes += await weightBytes(join(path, entry.name), depth + 1);
      }
    }
    return bytes;
  };
  let bytes = 0;
  for (const path of paths) bytes += await weightBytes(path);
  if (bytes <= 0)
    throw new CapacityDeniedError(
      'Cannot determine the native model working set before starting it.',
    );
  const cpu =
    launch.args.includes('--cpu') ||
    launch.args.includes('--no-gpu') ||
    launch.args.some((arg, i) => arg === '--accelerator' && launch.args[i + 1] === 'cpu') ||
    launch.args.some(
      (arg, i) =>
        ['--n-gpu-layers', '--gpu-layers', '-ngl'].includes(arg) && launch.args[i + 1] === '0',
    );
  const reservation = Math.ceil(bytes * 1.5 + GIB);
  return { bytes: reservation, ...(cpu ? { gpuBytes: 0 } : {}) };
}

/**
 * The refusal a person can act on: which two numbers disagreed, and that the
 * memory is held by their other applications rather than by Gezel. The old
 * wording ("current engine work is still protected") described a queue that,
 * in this branch, has nothing in it.
 */
function formatHostMemoryShortfall(reply: NativeCapacityReply): string {
  const gb = (bytes: number) => `${(bytes / GIB).toFixed(1)} GB`;
  if (reply.requiredBytes === undefined || reply.availableBytes === undefined)
    return 'Not enough free memory on this device to start this model right now. Close some applications and retry, or choose a smaller model.';
  return [
    'Not enough free memory on this device to start this model: it needs about ',
    `${gb(reply.requiredBytes)}, and ${gb(reply.availableBytes)} is available right now. `,
    'The rest is in use by other applications, not by Gezel — closing some and retrying ',
    'will help, as will choosing a smaller model.',
  ].join('');
}

export async function acquireNativeCapacity(
  options: NativeCapacityOptions,
  launch: NativeEngineLaunch,
  signal: AbortSignal,
  onWait: (message: string) => void,
): Promise<NativeCapacityLease> {
  const execute = options.execute ?? (await capacityExecutor(options.home));
  const requirement = (await options.requirement?.()) ?? (await estimateNativeLaunchMemory(launch));
  const budget = await measuredCapacityBudget();
  const id = randomUUID();
  const request = NativeCapacityCommandSchema.parse({
    action: 'acquire',
    id,
    ownerPid: process.pid,
    label: 'native model',
    bytes: Math.ceil(requirement.bytes),
    gpuBytes: Math.ceil(
      requirement.gpuBytes ??
        (budget.kind === 'system-ram'
          ? 0
          : budget.kind === 'discrete-gpu'
            ? Math.min(requirement.bytes, budget.fastBytes)
            : requirement.bytes),
    ),
    exclusive: requirement.exclusive ?? options.exclusive ?? false,
  });
  const started = awakeNow();
  let lastReport = Number.NEGATIVE_INFINITY;
  let externalSince: number | undefined;
  try {
    for (;;) {
      signal.throwIfAborted();
      if (request.action === 'acquire') request.priority = options.priority?.() ?? 'interactive';
      const reply = await execute(request);
      signal.throwIfAborted();
      if (reply.state === 'granted') break;
      if (reply.externalShortfall) {
        externalSince ??= awakeNow();
        if (awakeNow() - externalSince >= EXTERNAL_SHORTFALL_WAIT_MS)
          throw new CapacityDeniedError(formatHostMemoryShortfall(reply));
      } else {
        externalSince = undefined;
      }
      if (awakeNow() - started >= WAIT_MS)
        throw new CapacityDeniedError(
          'Not enough memory became available for this model. Current engine work is still protected; retry when it finishes.',
        );
      if (awakeNow() - lastReport >= 15_000) {
        onWait(reply.reason ?? 'Waiting for memory.');
        lastReport = awakeNow();
      }
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          resolve();
        };
        const abort = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          reject(signal.reason);
        };
        const timer = setTimeout(done, POLL_MS);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  } catch (error) {
    await execute({ action: 'release', id }).catch(() => {});
    throw error;
  }
  return {
    bind: async (childPid) => {
      if ((await execute({ action: 'bind', id, childPid })).state !== 'granted')
        throw new CapacityDeniedError('The engine memory reservation was lost before startup.');
    },
    ready: async () => {
      if ((await execute({ action: 'ready', id })).state !== 'granted')
        throw new CapacityDeniedError('The engine memory reservation was lost during startup.');
    },
    release: async () => {
      await execute({ action: 'release', id });
    },
    shouldYield: async () => {
      const reply = await execute({ action: 'status', id });
      return reply.state !== 'granted' || reply.releaseRequested;
    },
  };
}
