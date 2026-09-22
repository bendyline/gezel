import {
  MobileInferenceBudgetSchema,
  type MobileModelInventory,
  MobileModelInventorySchema,
  MobileModelSchema,
  type MobileProvider,
  type MobileProviderId,
  MobileProviderListSchema,
} from '../schemas/mobile-provider.js';

export interface PortableInference {
  providers(): Promise<MobileProvider[]>;
  models?(): Promise<MobileModelInventory>;
  generate(
    request: {
      requestId: string;
      providerId: MobileProviderId;
      modelId?: string;
      contextSize?: number;
      maxTokens?: number;
      messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    },
    onDelta: (event: { requestId: string; delta: string }) => void,
  ): Promise<{ text: string; stopReason: 'stop' | 'length' | 'cancelled' }>;
  cancel(requestId: string): Promise<void>;
}

/** Minimal native bridge: no Capacitor, product storage, previews, or speech dependency. */
export interface NativeInferencePlugin {
  providers(): Promise<{ providers: MobileProvider[] }>;
  listModels(): Promise<MobileModelInventory>;
  generate(
    request: Parameters<PortableInference['generate']>[0],
  ): ReturnType<PortableInference['generate']>;
  cancel(options: { requestId: string }): Promise<void>;
  addListener(
    event: 'chatDelta',
    callback: (event: { requestId: string; delta: string }) => void,
  ): Promise<NativeInferenceListener>;
}

export interface NativeInferenceListener {
  remove(): Promise<void>;
}

const adapters = new WeakMap<NativeInferencePlugin, PortableInference>();

/** Reuses admission and cancellation state for callers sharing one native plugin.
 * Native hosts must also enforce process-wide admission and foreground lifecycle.
 * This is a host adapter for the existing SDK, not a second application client.
 */
export function createNativeInference(plugin: NativeInferencePlugin): PortableInference {
  const existing = adapters.get(plugin);
  if (existing) return existing;
  const runs = new Map<string, { cancelled: boolean; started: boolean; released: Promise<void> }>();
  const inference: PortableInference = {
    models: async () => MobileModelInventorySchema.parse(await plugin.listModels()),
    async providers() {
      const result = await plugin.providers();
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
      let listener: NativeInferenceListener | undefined;
      try {
        listener = await plugin.addListener('chatDelta', (event) => {
          if (!run.cancelled && event.requestId === request.requestId) onDelta(event);
        });
        if (run.cancelled) return { text: '', stopReason: 'cancelled' };
        run.started = true;
        const budget = MobileInferenceBudgetSchema.parse({
          contextSize: request.contextSize ?? 4096,
          maxTokens: request.maxTokens ?? 1024,
        });
        if (request.providerId === 'llama-cpp') MobileModelSchema.shape.id.parse(request.modelId);
        else if (request.modelId !== undefined && request.modelId !== request.providerId)
          throw new Error('The requested model is not available from this on-device provider');
        return await plugin.generate({ ...request, ...budget });
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
      if (run.started) await plugin.cancel({ requestId });
      await run.released;
    },
  };
  adapters.set(plugin, inference);
  return inference;
}
