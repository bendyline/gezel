import type { GezelApp } from './client.js';
import { type TextOptions, type TextRequest, streamEmbeddingText } from './embedding-text.js';
import { GezelSdkError } from './errors.js';
import type { KnowledgeClient } from './knowledge-client.js';
import { type ModelManager, type PrepareModelOptions, notify, sdkError } from './model-manager.js';
import type { RequestOptions } from './types.js';
export type { TextRequest, TextOptions, TextEvent } from './embedding-text.js';

export interface EmbeddingConnection {
  app: GezelApp | GezelApp<'portable'>;
  models: ModelManager;
  knowledge?: Pick<KnowledgeClient, 'state' | 'update' | 'retrieve'>;
  /** Await transport disposal and native memory release here. */
  close(): Promise<void>;
}
export type EmbeddingState = 'disabled' | 'idle' | 'connecting' | 'ready' | 'suspended' | 'closed';
export interface EmbeddingOptions {
  /** Called lazily, only after opt-in. Silent mode must never raise a consent prompt. */
  connect(options: { interactive: boolean }): Promise<EmbeddingConnection>;
  onState?(state: EmbeddingState): void;
}
/** Optional application lifecycle. Preferences and UI remain owned by the embedding app. */
export function createEmbedding(options: EmbeddingOptions) {
  let enabled = false;
  let suspended = false;
  let closed = false;
  let epoch = 0;
  let state: EmbeddingState = 'disabled';
  let connection: EmbeddingConnection | undefined;
  let pending: Promise<EmbeddingConnection> | undefined;
  let shutdown: Promise<void> = Promise.resolve();
  const operations = new Map<AbortController, Promise<unknown>>();
  const publish = (next: EmbeddingState) => {
    state = next;
    notify(options.onState, next);
  };
  const check = () => {
    if (closed) throw new GezelSdkError('Embedding is closed', { code: 'closed' });
    if (!enabled) throw new GezelSdkError('AI is disabled', { code: 'disabled' });
    if (suspended) throw new GezelSdkError('AI is suspended', { code: 'suspended' });
  };
  async function dispose(value: EmbeddingConnection): Promise<void> {
    try {
      try {
        await value.models.close();
      } finally {
        await value.close();
      }
    } catch (cause) {
      throw new GezelSdkError('The AI runtime could not finish cleanup', {
        code: 'cleanup_failed',
        cause,
      });
    }
  }
  async function getConnection(interactive = false): Promise<EmbeddingConnection> {
    check();
    await shutdown;
    check();
    if (connection) return connection;
    if (!pending) {
      const generation = epoch;
      publish('connecting');
      const task = Promise.resolve()
        .then(() => options.connect({ interactive }))
        .then(async (value) => {
          if (generation !== epoch || closed || !enabled || suspended) {
            await dispose(value);
            throw new GezelSdkError('Connection was superseded', { code: 'aborted' });
          }
          connection = value;
          publish('ready');
          return value;
        });
      pending = task;
      void task.then(
        () => {
          if (pending === task) pending = undefined;
        },
        () => {
          if (pending === task) {
            pending = undefined;
            if (enabled && !closed && !suspended) publish('idle');
          }
        },
      );
    }
    return pending;
  }
  function run<T>(
    signal: AbortSignal | undefined,
    action: (value: EmbeddingConnection, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const task = (async () => {
      combined.throwIfAborted();
      const value = await getConnection();
      combined.throwIfAborted();
      const result = await action(value, combined);
      combined.throwIfAborted();
      return result;
    })().catch((error) => {
      throw sdkError(error);
    });
    operations.set(controller, task);
    void task.then(
      () => operations.delete(controller),
      () => operations.delete(controller),
    );
    return task;
  }
  async function stop(): Promise<void> {
    epoch++;
    for (const controller of operations.keys()) controller.abort();
    const previous = shutdown;
    const current = connection;
    const connecting = pending;
    connection = undefined;
    pending = undefined;
    const tasks = [...operations.values()];
    shutdown = (async () => {
      await previous;
      await connecting?.catch((error) => {
        if (sdkError(error).code === 'cleanup_failed') throw error;
      });
      if (current) await dispose(current);
    })();
    await shutdown;
    await Promise.allSettled(tasks);
  }
  return {
    get state() {
      return state;
    },
    async setEnabled(value: boolean) {
      if (closed) throw new GezelSdkError('Embedding is closed', { code: 'closed' });
      enabled = value;
      if (!value) {
        publish('disabled');
        await stop();
      } else publish(suspended ? 'suspended' : connection ? 'ready' : 'idle');
    },
    /** Call only from the user's Connect gesture. Reuses the same lifecycle and cleanup. */
    async reconnect() {
      check();
      await stop();
      await getConnection(true);
    },
    async suspend() {
      if (closed) return;
      suspended = true;
      publish(enabled ? 'suspended' : 'disabled');
      await stop();
    },
    resume() {
      if (closed) return;
      suspended = false;
      publish(enabled ? 'idle' : 'disabled');
    },
    async close() {
      if (closed) {
        await shutdown;
        return;
      }
      closed = true;
      enabled = false;
      publish('closed');
      await stop();
    },
    models: {
      list: (opts: RequestOptions = {}) =>
        run(opts.signal, (value, signal) => value.models.list({ signal })),
      inspect: (id: string, opts: RequestOptions = {}) =>
        run(opts.signal, (value, signal) => value.models.inspect(id, { signal })),
      prepare: (id: string, opts: PrepareModelOptions = {}) =>
        run(opts.signal, (value, signal) => value.models.prepare(id, { ...opts, signal })),
    },
    knowledge: {
      state: (opts: RequestOptions = {}) =>
        run(opts.signal, (value, signal) => {
          if (!value.knowledge)
            throw new GezelSdkError('Knowledge is not enabled', { code: 'knowledge_unavailable' });
          return value.knowledge.state({ signal });
        }),
      update: (action: Parameters<KnowledgeClient['update']>[0], opts: RequestOptions = {}) =>
        run(opts.signal, (value, signal) => {
          if (!value.knowledge)
            throw new GezelSdkError('Knowledge is not enabled', { code: 'knowledge_unavailable' });
          return value.knowledge.update(action, { signal });
        }),
      retrieve: (query: Parameters<KnowledgeClient['retrieve']>[0], opts: RequestOptions = {}) =>
        run(opts.signal, (value, signal) => {
          if (!value.knowledge)
            throw new GezelSdkError('Knowledge is not enabled', { code: 'knowledge_unavailable' });
          return value.knowledge.retrieve(query, { signal });
        }),
    },
    streamText(request: TextRequest, opts: TextOptions = {}) {
      return streamEmbeddingText(run, request, opts);
    },
  };
}
export type GezelEmbedding = ReturnType<typeof createEmbedding>;
