import type { ProviderName } from '@bendyline/gezel';
import { createLogger } from '@bendyline/gezel';
import { classifyModelTier } from '../chat/local-model-tier.js';
import type { ChatManager } from '../chat/manager.js';
import type { Store } from '../fs/store.js';
import { describeCurrentHardware } from '../system/hardware-description.js';
import { detectMemoryProfile } from '../system/memory.js';
import type { HandboekDeviceInfo, HandboekHardwareInfo, HandboekModelInfo } from './device.js';

const log = createLogger('handboek');

/**
 * Deliberately NOT re-exported from engine.ts: the `./handboek` subpath
 * must stay importable without dragging the daemon graph (Store,
 * ChatManager, providers) along — the CLI static-site export imports
 * that subpath standalone. Only service.ts should import this file.
 */
const LOCAL_ENGINE_PROVIDERS: readonly ProviderName[] = ['llama-cpp', 'mlx', 'ds4', 'ollama'];

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
