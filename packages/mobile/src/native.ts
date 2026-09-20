import {
  type MobileModel,
  type MobileModelInventory,
  MobileModelInventorySchema,
  MobileModelSchema,
  type MobileProvider,
  type MobileProviderId,
  MobileProviderListSchema,
} from '@bendyline/gezel/mobile-providers';
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import type { MobileInference, MobileStorage } from './runtime/index.js';

export type { MobileModel } from '@bendyline/gezel/schemas';
export type ModelInventory = MobileModelInventory;

export interface GezelMobilePlugin {
  readState(): Promise<{ data: string | null }>;
  writeState(options: { data: string }): Promise<void>;
  listModels(): Promise<ModelInventory>;
  importModel(): Promise<{ model: MobileModel | null }>;
  selectModel(options: { id: string }): Promise<{ model: MobileModel }>;
  removeModel(options: { id: string }): Promise<void>;
  providers(): Promise<{ providers: MobileProvider[] }>;
  prepareProvider(options: { providerId: MobileProviderId }): Promise<void>;
  cancelProviderPreparation(options: { providerId: MobileProviderId }): Promise<void>;
  generate(options: {
    requestId: string;
    providerId: MobileProviderId;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    maxTokens?: number;
    contextSize?: number;
  }): Promise<{ text: string; stopReason: 'stop' | 'length' | 'cancelled' }>;
  cancel(options: { requestId: string }): Promise<void>;
  addListener(
    event: 'chatDelta',
    callback: (event: { requestId: string; delta: string }) => void,
  ): Promise<PluginListenerHandle>;
}

export interface MobileHost {
  native: boolean;
  storage: MobileStorage;
  inference: MobileInference;
  listModels(): Promise<ModelInventory>;
  importModel(): Promise<{ model: MobileModel | null }>;
  selectModel(id: string): Promise<{ model: MobileModel }>;
  removeModel(id: string): Promise<void>;
  prepareProvider(providerId: MobileProviderId): Promise<void>;
  cancelProviderPreparation(providerId: MobileProviderId): Promise<void>;
}

const plugin = registerPlugin<GezelMobilePlugin>('GezelMobile');

export function createNativeHost(nativePlugin: GezelMobilePlugin = plugin): MobileHost {
  const runs = new Map<string, { cancelled: boolean; started: boolean; released: Promise<void> }>();
  return {
    native: true,
    storage: {
      load: async () => (await nativePlugin.readState()).data,
      save: async (data) => {
        await nativePlugin.writeState({ data });
      },
    },
    inference: {
      async providers() {
        const result = await nativePlugin.providers();
        return MobileProviderListSchema.parse(result.providers);
      },
      async generate(request, onDelta) {
        if (runs.size) throw new Error('A response is already running');
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        const run = { cancelled: false, started: false, released };
        runs.set(request.requestId, run);
        let listener: PluginListenerHandle | undefined;
        try {
          listener = await nativePlugin.addListener('chatDelta', (event) => {
            if (!run.cancelled && event.requestId === request.requestId) onDelta(event);
          });
          if (run.cancelled) return { text: '', stopReason: 'cancelled' };
          run.started = true;
          return await nativePlugin.generate({ ...request, maxTokens: 256, contextSize: 2048 });
        } finally {
          run.cancelled = true;
          try {
            await listener?.remove();
          } catch {
            // Teardown cannot replace the model's authoritative result (or error).
            // The sealed run also ignores callbacks if the native listener survived.
          } finally {
            runs.delete(request.requestId);
            release();
          }
        }
      },
      cancel: async (requestId) => {
        const run = runs.get(requestId);
        if (!run) return;
        run.cancelled = true;
        if (run.started) await nativePlugin.cancel({ requestId });
        await run.released;
      },
    },
    listModels: async () => MobileModelInventorySchema.parse(await nativePlugin.listModels()),
    importModel: async () => {
      const { model } = await nativePlugin.importModel();
      return { model: model === null ? null : MobileModelSchema.parse(model) };
    },
    selectModel: async (id) => ({
      model: MobileModelSchema.parse((await nativePlugin.selectModel({ id })).model),
    }),
    removeModel: async (id) => {
      await nativePlugin.removeModel({ id });
    },
    prepareProvider: async (providerId) => {
      await nativePlugin.prepareProvider({ providerId });
    },
    cancelProviderPreparation: async (providerId) => {
      await nativePlugin.cancelProviderPreparation({ providerId });
    },
  };
}

export function isNativeHost(): boolean {
  return Capacitor.isNativePlatform();
}
