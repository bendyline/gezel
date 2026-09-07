import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { homedir, totalmem } from 'node:os';
import { join } from 'node:path';
import {
  type NativeCapacityCommand,
  NativeCapacityCommandSchema,
  type NativeCapacityReply,
  NativeCapacityReplySchema,
  awakeNow,
} from '@bendyline/gezel';
import { readSystemServiceRuntime, systemServiceHome } from '@bendyline/gezel-client/node';
import { ConfigStore } from '../../fs/config-store.js';
import { createPinnedFetch } from '../../remotes/pinned-fetch.js';
import { sampleDarwinSystemMemory } from '../../system/darwin-memory.js';
import { CapacityDeniedError, availableSystemRamBytes } from './capacity-broker.js';
import { DeviceCapacityLedger, type DeviceCapacitySample } from './device-capacity-ledger.js';
import { measuredCapacityBudget } from './measured-budget.js';
import type { NativeEngineLaunch } from './supervisor.js';

const GIB = 1024 ** 3;
const POLL_MS = 500;
const WAIT_MS = 5 * 60_000;
// Once an installed broker owns this process's reservations, its disappearance
// is an outage, never permission to create a competing local ledger.
const observedMachineAuthorities = new Set<string>();

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
  const darwin = await sampleDarwinSystemMemory({ totalBytes: ram });
  const availableRam = darwin ? darwin.freeBytes + darwin.cachedBytes : availableSystemRamBytes();
  // The ledger's RAM ceiling and the OS's currently reclaimable RAM answer
  // different questions. Checking both catches tenants outside this protocol.
  const availableBytes =
    Math.max(0, availableRam - Math.min(4 * GIB, ram * 0.1)) + budget.vramBytes;
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
  if (process.env.GEZEL_NATIVE_CAPACITY_AUTHORITY === 'local') {
    const ledger = localDeviceCapacity(home);
    return (command) => ledger.execute(command);
  }
  const machineHome = systemServiceHome();
  if (machineHome && machineHome !== home) {
    const runtime = await readSystemServiceRuntime(machineHome);
    if (runtime?.serviceRole === 'machine-engine') {
      observedMachineAuthorities.add(machineHome);
      const { inspectMachineRuntime } = await import('../../machine-engine/bridge.js');
      const identity = await inspectMachineRuntime(runtime);
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
  try {
    for (;;) {
      signal.throwIfAborted();
      if (request.action === 'acquire') request.priority = options.priority?.() ?? 'interactive';
      const reply = await execute(request);
      signal.throwIfAborted();
      if (reply.state === 'granted') break;
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
