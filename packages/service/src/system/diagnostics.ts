import { existsSync } from 'node:fs';
import { release } from 'node:os';
import {
  GEZEL_VERSION,
  type NativeEngineName,
  type SystemDiagnostics,
  createLogger,
  nowIso,
} from '@bendyline/gezel';
import { resolvePlatformKey } from '@bendyline/gezel/native';
import type { ChatManager } from '../chat/manager.js';
import { effectiveEngineRelease, isEnginePinned } from '../engines/native-manifest.js';
import { KNOWN_ENGINES } from '../engines/registry.js';
import type { Store } from '../fs/store.js';
import { readLlamaCppBuildMetadata } from '../providers/llama-cpp/build-metadata.js';
import {
  type LlamaDevice,
  matchNvidiaRuntimeDevice,
  probeLlamaDevices,
  probeNvidiaRuntimeDevices,
} from '../providers/llama-cpp/devices.js';
import { describeCurrentHardware } from './hardware-description.js';
import { detectMemoryProfileCached } from './memory.js';

const log = createLogger('system');

/**
 * Assemble the shareable machine profile behind the "Report error on GitHub"
 * dialog.
 *
 * The privacy contract lives on `SystemDiagnosticsSchema`. The rule this file
 * has to hold up: emit engine and model NAMES, never the paths they resolve
 * to. Every absolute path on this machine embeds the OS username, which makes
 * `engines[].path` — the field the sibling `/api/engines/binaries/status`
 * route does return — the single likeliest way to leak PII here.
 */

const ENGINE_ENV_VAR: Record<NativeEngineName, string> = {
  'llama-server': 'GEZEL_LLAMA_SERVER_BIN',
  'ds4-server': 'GEZEL_DS4_SERVER_BIN',
  'sd-server': 'GEZEL_SD_SERVER_BIN',
  'whisper-server': 'GEZEL_WHISPER_SERVER_BIN',
  uv: 'GEZEL_UV_BIN',
};

const LOCAL_ENGINE_PROVIDERS = ['llama-cpp', 'mlx', 'ds4'] as const;

const MAX_INSTALLED_MODELS = 40;
const BACKENDS = ['cuda', 'vulkan', 'metal', 'cpu'] as const;
type LlamaBackend = (typeof BACKENDS)[number];

function asBackend(value: string | undefined): LlamaBackend | undefined {
  return BACKENDS.find((backend) => backend === value);
}

export interface SystemDiagnosticsDeps {
  home: string;
  store: Store;
  chat: Pick<ChatManager, 'listModelsForProvider'>;
}

async function collectGpuDevices(
  home: string,
  source: string,
): Promise<SystemDiagnostics['hardware']['gpuDevices']> {
  const binaryPath = process.env.GEZEL_LLAMA_SERVER_BIN;
  if (!binaryPath) return [];
  let devices: LlamaDevice[] = [];
  try {
    devices = (await probeLlamaDevices({ binaryPath, home })).devices;
  } catch (err) {
    log.debug(`diagnostics: llama device probe failed: ${String(err)}`);
    return [];
  }
  // `--list-devices` includes CPU/BLAS pseudo-devices at 0 MiB. They carry no
  // triage signal and would read as a phantom GPU in the report.
  const gpus = devices.filter((device) => device.totalMiB > 0);
  // nvidia-smi is a process spawn with a 5s timeout; only pay for it on the
  // one host class where it can possibly answer.
  const nvidia = source === 'gpu-nvidia' ? await probeNvidiaRuntimeDevices() : [];
  return gpus.map((device) => {
    const runtime = nvidia.length > 0 ? matchNvidiaRuntimeDevice(device, nvidia) : undefined;
    return {
      name: device.name,
      totalMiB: device.totalMiB,
      ...(runtime?.computeCapability ? { computeCapability: runtime.computeCapability } : {}),
      ...(runtime?.driverVersion ? { driverVersion: runtime.driverVersion } : {}),
    };
  });
}

async function collectInstalledModels(
  chat: SystemDiagnosticsDeps['chat'],
): Promise<SystemDiagnostics['models']['installed']> {
  const out: SystemDiagnostics['models']['installed'] = [];
  for (const provider of LOCAL_ENGINE_PROVIDERS) {
    try {
      for (const model of await chat.listModelsForProvider(provider)) {
        out.push({
          id: model.id,
          provider,
          ...(model.parameterSize ? { parameterSize: model.parameterSize } : {}),
        });
      }
    } catch (err) {
      // An engine that isn't installed just contributes nothing.
      log.debug(`diagnostics: listing ${provider} models failed: ${String(err)}`);
    }
  }
  return out.slice(0, MAX_INSTALLED_MODELS);
}

async function collectLlamaBuild(): Promise<Partial<SystemDiagnostics['engine']>> {
  const binaryPath = process.env.GEZEL_LLAMA_SERVER_BIN;
  if (!binaryPath) return {};
  const build = await readLlamaCppBuildMetadata(binaryPath).catch(() => null);
  if (!build) return {};
  return {
    llamaCppRevision: build.revision,
    llamaCppBuildBackend: build.backend,
    ...(build.cudaArchitectures ? { cudaArchitectures: build.cudaArchitectures } : {}),
    ...(build.cudaToolkit ? { cudaToolkit: build.cudaToolkit } : {}),
  };
}

/**
 * Never throws. A probe that fails contributes nothing and the report is
 * thinner — a dialog that cannot open at all is the worse outcome, and the
 * moment a user most wants to file a bug is the moment this machine is
 * least healthy.
 */
export async function collectSystemDiagnostics(
  deps: SystemDiagnosticsDeps,
): Promise<SystemDiagnostics> {
  const memory = await detectMemoryProfileCached();
  const hardware = describeCurrentHardware(memory);

  const [config, gpuDevices, installed, llamaBuild] = await Promise.all([
    deps.store.readConfig().catch(() => null),
    collectGpuDevices(deps.home, memory.source),
    collectInstalledModels(deps.chat),
    collectLlamaBuild(),
  ]);

  const defaultProvider = config?.provider ?? 'copilot';
  const defaultModel = config?.defaultModel?.[defaultProvider];

  return {
    version: GEZEL_VERSION,
    sampledAt: nowIso(),
    runtime: {
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      osRelease: release(),
      platformKey: resolvePlatformKey(),
    },
    hardware: {
      totalRamBytes: memory.totalRamBytes,
      gpuVramBytes: memory.gpuVramBytes,
      usableBytes: memory.usableBytes,
      budgetBytes: memory.budgetBytes,
      source: memory.source,
      ...(memory.gpuVendor ? { gpuVendor: memory.gpuVendor } : {}),
      description: hardware.description,
      tier: hardware.tier,
      gpuDevices,
    },
    engine: {
      nativeRelease: effectiveEngineRelease(),
      nativePinned: isEnginePinned(),
      installedEngines: KNOWN_ENGINES.filter((name) => {
        const path = process.env[ENGINE_ENV_VAR[name]];
        return !!path && existsSync(path);
      }),
      ...(asBackend(process.env.GEZEL_LLAMA_SERVER_BACKEND)
        ? { llamaCppBackend: asBackend(process.env.GEZEL_LLAMA_SERVER_BACKEND) }
        : {}),
      ...(asBackend(process.env.GEZEL_LLAMA_DETECTED_BACKEND)
        ? { llamaCppDetectedBackend: asBackend(process.env.GEZEL_LLAMA_DETECTED_BACKEND) }
        : {}),
      ...(config?.llamaCppBackendOverride
        ? { llamaCppBackendOverride: config.llamaCppBackendOverride }
        : {}),
      ...llamaBuild,
    },
    models: {
      defaultProvider,
      ...(defaultModel ? { defaultModel } : {}),
      installed,
    },
  };
}

const CACHE_MS = 60_000;
let cache: { at: number; value: SystemDiagnostics } | null = null;

/**
 * 60s memo. Every field is a machine fact that changes only on GPU hot-plug,
 * engine install, or model install — none of which happen between two
 * openings of an error dialog. Without it each open re-reads engine
 * manifests and may spawn `nvidia-smi`.
 */
export async function collectSystemDiagnosticsCached(
  deps: SystemDiagnosticsDeps,
  now: () => number = Date.now,
): Promise<SystemDiagnostics> {
  const at = now();
  if (cache && at - cache.at < CACHE_MS) return cache.value;
  const value = await collectSystemDiagnostics(deps);
  cache = { at, value };
  return value;
}

/** Test seam. */
export function resetSystemDiagnosticsCache(): void {
  cache = null;
}
