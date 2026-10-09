import { AppModelSchema } from '@bendyline/gezel-client/app-models';
import type { GezelApp } from './client.js';
import { GezelSdkError } from './errors.js';
import type { ModelListEntry, RequestOptions } from './types.js';

export interface ModelDescriptor extends ModelListEntry {
  name: string;
  availability: NonNullable<ModelListEntry['availability']>;
  locality: NonNullable<ModelListEntry['locality']>;
  preparation: NonNullable<ModelListEntry['preparation']>;
}
export interface ModelProgress {
  phase: 'resolving' | 'engine' | 'downloading' | 'verifying' | 'preparing';
  percent?: number;
  message: string;
  bytesWritten?: number;
  totalBytes?: number;
}
export interface PrepareModelOptions extends RequestOptions {
  /** Explicit permission for this operation to download model data. Defaults to false. */
  allowDownload?: boolean;
  onProgress?(event: ModelProgress): void;
}
export interface ModelAdapter {
  list(options: RequestOptions): Promise<ModelListEntry[]>;
  /** Return the installed ID (a catalog ID may resolve to a native inventory ID). */
  prepare(id: string, options: PrepareModelOptions & { signal: AbortSignal }): Promise<string>;
  /** HTTP jobs can be shared with other apps; aborting their observation does not cancel them. */
  cancellation: 'observation' | 'download';
  /** Hosted engines can require preparation even when their weights are already present. */
  prepareAvailable?: boolean;
}
export interface ModelWatch {
  ready: Promise<void>;
  dispose(): Promise<void>;
}
export interface ModelManager {
  readonly cancellation: ModelAdapter['cancellation'];
  list(options?: RequestOptions): Promise<ModelDescriptor[]>;
  inspect(id: string, options?: RequestOptions): Promise<ModelDescriptor | null>;
  prepare(id: string, options?: PrepareModelOptions): Promise<ModelDescriptor>;
  watch(
    listener: (models: ModelDescriptor[]) => void,
    options?: RequestOptions & {
      intervalMs?: number;
      onError?(error: GezelSdkError): void;
    },
  ): ModelWatch;
  close(): Promise<void>;
}
export function sdkError(error: unknown): GezelSdkError {
  if (error instanceof GezelSdkError) return error;
  const detail = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const aborted = detail.name === 'AbortError';
  return new GezelSdkError(
    aborted
      ? 'Operation cancelled'
      : typeof detail.message === 'string'
        ? detail.message.slice(0, 4096)
        : 'Gezel operation failed',
    {
      code: aborted
        ? 'aborted'
        : typeof detail.code === 'string' && detail.code.length <= 128
          ? detail.code
          : detail.name === 'ZodError'
            ? 'invalid_response'
            : 'runtime_error',
      cause: error,
    },
  );
}
export function notify<T>(listener: ((value: T) => void) | undefined, value: T): void {
  try {
    listener?.(value);
  } catch {
    /* An observer cannot own the operation's outcome. */
  }
}
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
export function describeModel(value: ModelListEntry): ModelDescriptor {
  const parsed = AppModelSchema.safeParse(value);
  if (!parsed.success)
    throw new GezelSdkError('Invalid model descriptor', {
      code: 'invalid_response',
      cause: parsed.error,
    });
  const model = parsed.data;
  return {
    ...model,
    name: model.name ?? model.id,
    availability: model.availability ?? 'available',
    locality: model.locality ?? 'unknown',
    preparation: model.preparation ?? 'unknown',
  };
}
/** No implicit replacement of a person's selected model. Fallback is a caller policy. */
export function selectModel(
  models: readonly ModelDescriptor[],
  options: {
    preferredId?: string | null;
    fallback?: 'none' | 'first-ready' | 'prefer-system';
  } = {},
): ModelDescriptor | null {
  const preferred = models.find(
    (model) =>
      (model.id === options.preferredId ||
        (options.preferredId != null && model.aliases?.includes(options.preferredId))) &&
      model.availability === 'available',
  );
  if (preferred) return preferred;
  if (!options.fallback || options.fallback === 'none') return null;
  const ready = models.filter((model) => model.availability === 'available');
  return (
    (options.fallback === 'prefer-system'
      ? ready.find(
          (model) =>
            model.preparation === 'system-download' || model.preparation === 'system-settings',
        )
      : undefined) ??
    ready[0] ??
    null
  );
}
/** Shared model lifecycle, with no implicit preparation during list/inspect/watch. */
export function createModelManager(adapter: ModelAdapter): ModelManager {
  const lifetime = new AbortController();
  const tasks = new Set<Promise<unknown>>();
  const watches = new Set<ModelWatch>();
  let preparing = false;
  let closing: Promise<void> | undefined;
  const signalFor = (signal?: AbortSignal) => {
    if (lifetime.signal.aborted)
      throw new GezelSdkError('Model manager is closed', { code: 'closed' });
    const combined = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
    combined.throwIfAborted();
    return combined;
  };
  const track = <T>(task: Promise<T>): Promise<T> => {
    tasks.add(task);
    void task.then(
      () => tasks.delete(task),
      () => tasks.delete(task),
    );
    return task;
  };
  const list: ModelManager['list'] = (options = {}) =>
    track(
      (async () => {
        const signal = signalFor(options.signal);
        const result = await adapter.list({ signal });
        signal.throwIfAborted();
        if (result.length > 10000)
          throw new GezelSdkError('Model inventory exceeds its limit', {
            code: 'invalid_response',
          });
        const models = result.map(describeModel);
        if (new Set(models.map((model) => model.id)).size !== models.length)
          throw new GezelSdkError('Duplicate model identities', { code: 'invalid_response' });
        return models;
      })().catch((error) => {
        throw sdkError(error);
      }),
    );
  const manager: ModelManager = {
    cancellation: adapter.cancellation,
    list,
    async inspect(id, options) {
      return (
        (await list(options)).find((model) => model.id === id || model.aliases?.includes(id)) ??
        null
      );
    },
    prepare(id, options = {}) {
      return track(
        (async () => {
          const signal = signalFor(options.signal);
          if (!id || id.length > 512)
            throw new GezelSdkError('Invalid model identity', { code: 'invalid_request' });
          if (preparing)
            throw new GezelSdkError('Another model is being prepared', { code: 'busy' });
          preparing = true;
          try {
            const before = await manager.inspect(id, { signal });
            if (before?.availability === 'available' && !adapter.prepareAvailable) return before;
            if (before?.availability !== 'available' && !options.allowDownload)
              throw new GezelSdkError('Model preparation requires an explicit download action', {
                code: 'model_download_required',
              });
            const installedId = await adapter.prepare(before?.id ?? id, {
              ...options,
              signal,
              onProgress: (event) => notify(options.onProgress, event),
            });
            signal.throwIfAborted();
            const ready = await manager.inspect(installedId, { signal });
            if (!ready || ready.availability !== 'available')
              throw new GezelSdkError('Preparation finished without a ready model', {
                code: 'model_not_ready',
              });
            return ready;
          } finally {
            preparing = false;
          }
        })().catch((error) => {
          throw sdkError(error);
        }),
      );
    },
    watch(listener, options = {}) {
      const interval = options.intervalMs ?? 1000;
      if (!Number.isFinite(interval) || interval < 100 || interval > 60000)
        throw new GezelSdkError('Watch interval must be 100–60000ms', { code: 'invalid_request' });
      const controller = new AbortController();
      const signal = AbortSignal.any([signalFor(options.signal), controller.signal]);
      let resolveReady!: () => void;
      let rejectReady!: (error: unknown) => void;
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      void ready.catch(() => {});
      let previous = '';
      const task = (async () => {
        try {
          while (!signal.aborted) {
            const models = await list({ signal });
            signal.throwIfAborted();
            const serialized = JSON.stringify(
              models.map(({ created: _created, ...model }) => model),
            );
            if (serialized !== previous) {
              previous = serialized;
              notify(listener, models);
            }
            resolveReady();
            await abortableDelay(interval, signal);
          }
        } catch (error) {
          rejectReady(sdkError(error));
          if (!signal.aborted) notify(options.onError, sdkError(error));
        }
      })();
      const watch = {
        ready,
        async dispose() {
          controller.abort();
          await task;
          watches.delete(watch);
        },
      };
      watches.add(watch);
      void task.then(() => watches.delete(watch));
      return watch;
    },
    close() {
      if (!closing) {
        lifetime.abort();
        closing = (async () => {
          await Promise.all([...watches].map((watch) => watch.dispose()));
          const outcomes = await Promise.allSettled([...tasks]);
          const failed = outcomes.find(
            (outcome) =>
              outcome.status === 'rejected' && sdkError(outcome.reason).code === 'cleanup_failed',
          );
          if (failed?.status === 'rejected') throw failed.reason;
        })();
      }
      return closing;
    },
  };
  return manager;
}
/** The legacy HTTP ensure endpoint owns shared jobs: cancellation stops observation only. */
export function createHttpModelManager(
  app: Pick<GezelApp, 'models' | 'ensureModel' | 'streamEnsureEvents'>,
): ModelManager {
  return createModelManager({
    cancellation: 'observation',
    async list(options) {
      return (await app.models(options)).data;
    },
    async prepare(id, options) {
      const result = await app.ensureModel({ model: id }, options);
      if (result.model_id !== id)
        throw new GezelSdkError('Model preparation identity changed', { code: 'invalid_response' });
      if (result.status === 'ready') return id;
      let complete = false;
      for await (const event of app.streamEnsureEvents(result.job_id, options)) {
        options.signal.throwIfAborted();
        if (event.jobId !== result.job_id || event.modelId !== id)
          throw new GezelSdkError('Model preparation event identity changed', {
            code: 'invalid_response',
          });
        if (event.type === 'error')
          throw new GezelSdkError(event.error, { code: 'model_download_failed' });
        if (event.type === 'done') {
          complete = true;
          break;
        }
        notify(
          options.onProgress,
          event.type === 'progress'
            ? {
                phase: 'downloading',
                message: 'Downloading model',
                bytesWritten: event.bytesWritten,
                totalBytes: event.totalBytes,
              }
            : { phase: 'verifying', message: 'Preparing model' },
        );
      }
      if (!complete)
        throw new GezelSdkError('Model preparation stream ended before completion', {
          code: 'incomplete_stream',
        });
      return id;
    },
  });
}
