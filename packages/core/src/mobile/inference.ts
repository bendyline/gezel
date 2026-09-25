import {
  MobileInferenceBudgetSchema,
  type MobileModelInventory,
  MobileModelInventorySchema,
  MobileModelSchema,
  type MobileProvider,
  type MobileProviderId,
  MobileProviderListSchema,
} from '../schemas/mobile-provider.js';

/**
 * A tool's arguments in the ordered shape a native tool-calling API is built
 * from. JSON Schema object keys reach native code unordered, and argument order
 * steers generation (`path` before `content`). `json` carries a free-form
 * object as JSON text, since a constrained decoder cannot express one.
 */
export type MobileNativeToolSchema =
  | { kind: 'string'; description?: string; choices?: string[] }
  | { kind: 'integer' | 'number' | 'boolean' | 'json'; description?: string }
  | {
      kind: 'array';
      description?: string;
      items: MobileNativeToolSchema;
      minItems?: number;
      maxItems?: number;
    }
  | {
      kind: 'object';
      description?: string;
      properties: Array<{ name: string; optional: boolean; schema: MobileNativeToolSchema }>;
    }
  | { kind: 'anyOf'; description?: string; choices: MobileNativeToolSchema[] };

export interface MobileNativeTool {
  name: string;
  description: string;
  parameters: MobileNativeToolSchema & { kind: 'object' };
}

/** A call the provider's own tool loop made mid-generation. `arguments` is JSON text. */
export interface MobileNativeToolCall {
  requestId: string;
  callId: string;
  name: string;
  arguments: string;
}

/** `endTurn` stops generation after this result, e.g. once work was handed off. */
export interface MobileNativeToolReply {
  output: string;
  endTurn?: boolean;
}

export interface PortableInference {
  providers(): Promise<MobileProvider[]>;
  models?(): Promise<MobileModelInventory>;
  /** `tools` (with `onToolCall`) is only for providers advertising `capabilities.tools`. */
  generate(
    request: {
      requestId: string;
      providerId: MobileProviderId;
      modelId?: string;
      contextSize?: number;
      maxTokens?: number;
      messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
      tools?: MobileNativeTool[];
    },
    onDelta: (event: { requestId: string; delta: string }) => void,
    onToolCall?: (call: MobileNativeToolCall) => Promise<MobileNativeToolReply>,
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
  /** Hosts with native tool calling only. Exactly one of `output`/`error` is set. */
  completeToolCall?(options: {
    requestId: string;
    callId: string;
    output?: string;
    endTurn?: boolean;
    error?: string;
  }): Promise<void>;
  addListener(
    event: 'chatDelta',
    callback: (event: { requestId: string; delta: string }) => void,
  ): Promise<NativeInferenceListener>;
  addListener(
    event: 'toolCall',
    callback: (event: MobileNativeToolCall) => void,
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
    async generate(request, onDelta, onToolCall) {
      if (runs.size) throw new Error('A response is already running');
      if (request.tools?.length && (!onToolCall || !plugin.completeToolCall))
        throw new Error('Native tool calls need a handler and a host that can complete them');
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const run = { cancelled: false, started: false, released };
      runs.set(request.requestId, run);
      let listener: NativeInferenceListener | undefined;
      let toolListener: NativeInferenceListener | undefined;
      try {
        listener = await plugin.addListener('chatDelta', (event) => {
          if (!run.cancelled && event.requestId === request.requestId) onDelta(event);
        });
        if (request.tools?.length)
          toolListener = await plugin.addListener('toolCall', (event) => {
            if (run.cancelled || event.requestId !== request.requestId) return;
            const { requestId, callId } = event;
            Promise.resolve()
              .then(() => onToolCall!(event))
              .then(
                (reply) => plugin.completeToolCall!({ requestId, callId, ...reply }),
                (error: unknown) =>
                  plugin.completeToolCall!({
                    requestId,
                    callId,
                    error: error instanceof Error ? error.message : String(error),
                  }),
              )
              .catch(() => {
                // The native call already ended (cancelled or finished); its own
                // result, not this late completion, is authoritative.
              });
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
          await Promise.all([listener?.remove(), toolListener?.remove()]);
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
