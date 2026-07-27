import type { ProviderName } from '@bendyline/gezel';
import { createLogger } from '@bendyline/gezel';
import { classifyModelTier } from '../chat/local-model-tier.js';
import type { ChatManager } from '../chat/manager.js';
import type { Store } from '../fs/store.js';
import { detectMemoryProfile } from '../system/memory.js';
import type {
  HandboekDeviceInfo,
  HandboekHardwareInfo,
  HandboekHardwareTier,
  HandboekModelInfo,
} from './device.js';

const log = createLogger('handboek');

/**
 * Deliberately NOT re-exported from engine.ts: the `./handboek` subpath
 * must stay importable without dragging the daemon graph (Store,
 * ChatManager, providers) along — the CLI static-site export imports
 * that subpath standalone. Only service.ts should import this file.
 */
const LOCAL_ENGINE_PROVIDERS: readonly ProviderName[] = ['llama-cpp', 'mlx', 'ds4', 'ollama'];

// Keep these aligned with the device-capacity labels shown during local-model
// onboarding. The budget is the memory the engine may actually use, not total
// host RAM, so a tier never promises a model the runtime cannot safely load.
const LARGE_BUDGET_BYTES = 25_000_000_000;
const MEDIUM_BUDGET_BYTES = 13_000_000_000;
const SMALL_BUDGET_BYTES = 5_000_000_000;

export function classifyHardwareTier(usableBytes: number): HandboekHardwareTier {
  if (usableBytes >= LARGE_BUDGET_BYTES) return 'large';
  if (usableBytes >= MEDIUM_BUDGET_BYTES) return 'medium';
  if (usableBytes >= SMALL_BUDGET_BYTES) return 'small';
  return 'tiny';
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  return `${bytes} B`;
}

const GPU_VENDOR_LABEL = {
  amd: 'AMD',
  nvidia: 'NVIDIA',
  intel: 'Intel',
} as const;

export function describeCurrentHardware(profile: {
  totalRamBytes: number;
  gpuVramBytes: number | null;
  usableBytes: number;
  source: 'darwin-unified' | 'gpu-nvidia' | 'gpu-vulkan' | 'system-ram-fallback';
  gpuVendor?: keyof typeof GPU_VENDOR_LABEL;
}): HandboekHardwareInfo {
  const total = formatBytes(profile.totalRamBytes);
  const usable = formatBytes(profile.usableBytes);
  let description: string;
  if (profile.source === 'darwin-unified') {
    description = `Apple Silicon unified memory: ${total} total, with about ${usable} available for local models.`;
  } else if (profile.gpuVramBytes != null) {
    const vendor = profile.gpuVendor ? `${GPU_VENDOR_LABEL[profile.gpuVendor]} ` : '';
    description = `${vendor}GPU: ${formatBytes(profile.gpuVramBytes)} VRAM (about ${usable} available for local models), with ${total} system RAM.`;
  } else {
    description = `No dedicated GPU detected: ${total} system RAM, with about ${usable} available for CPU-based local models.`;
  }
  return { description, tier: classifyHardwareTier(profile.usableBytes) };
}

export function createDaemonDeviceInfo(deps: {
  store: Store;
  chat: ChatManager;
}): HandboekDeviceInfo {
  return {
    async listGezels() {
      const summaries = await deps.store.listGezels();
      return Promise.all(
        summaries.map(async (g) => ({
          id: g.id,
          name: g.name,
          role: g.role,
          poppetje: await deps.store.poppetjeManager.get(g.id, g.name, g.gender).catch(() => null),
        })),
      );
    },

    async meesterGezelId() {
      const config = await deps.store.readConfig();
      return config.meesterGezelId ?? null;
    },

    async listInstalledModels(): Promise<HandboekModelInfo[]> {
      const out: HandboekModelInfo[] = [];
      for (const provider of LOCAL_ENGINE_PROVIDERS) {
        try {
          const models = await deps.chat.listModelsForProvider(provider);
          for (const m of models) {
            out.push({
              id: m.id,
              name: m.name,
              provider,
              parameterSize: m.parameterSize,
              tier: classifyModelTier({
                providerName: provider,
                modelId: m.id,
                parameterSize: m.parameterSize,
              }),
            });
          }
        } catch (err) {
          // An engine that isn't installed (or a daemon that isn't running,
          // for Ollama) just contributes nothing to the device profile.
          log.debug(`handboek device info: listing ${provider} models failed: ${String(err)}`);
        }
      }
      return out;
    },

    async currentHardware(): Promise<HandboekHardwareInfo> {
      return describeCurrentHardware(await detectMemoryProfile());
    },
  };
}
