import { acquireSuspendMonitor, createAwakeTimeout } from '@bendyline/gezel';
import {
  GezelSdkError,
  type ModelListEntry,
  type PrepareModelOptions,
  abortableDelay,
  createModelManager,
  notify,
} from '@bendyline/gezel-app-sdk/browser';
import { createNativeInference } from '@bendyline/gezel/mobile-inference';
import {
  type MobileCatalogEntry,
  MobileCatalogSchema,
  MobileModelDownloadSchema,
  MobileModelDownloadsSchema,
  MobileModelInventorySchema,
  type MobileModelSourceIdentity,
  MobileModelSourceSchema,
  resolveMobileInferenceLimits,
} from '@bendyline/gezel/mobile-providers';
import snapshot from './catalog.json';
import type { GezelRuntimePlugin } from './definitions.js';
import { listModels } from './models.js';

export const mobileCatalog: readonly MobileCatalogEntry[] = MobileCatalogSchema.parse(
  snapshot.models,
);
export const mobileCatalogVersion = snapshot.version;
export interface MobileModelManagerOptions {
  catalog?: readonly MobileCatalogEntry[];
  pollIntervalMs?: number;
  preparationTimeoutMs?: number;
}
function field(value: unknown, key: string): unknown {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, key)
  )
    throw new GezelSdkError('Native runtime returned an invalid envelope', {
      code: 'invalid_response',
    });
  return (value as Record<string, unknown>)[key];
}
function sameSource(left: MobileModelSourceIdentity, right: MobileModelSourceIdentity): boolean {
  return (Object.keys(left) as (keyof MobileModelSourceIdentity)[]).every(
    (key) => left[key] === right[key],
  );
}
/** Model ownership, identity checks, preparation and cancellation formerly repeated by hosts. */
export function createMobileModelManager(
  runtime: GezelRuntimePlugin,
  options: MobileModelManagerOptions = {},
) {
  const catalog = MobileCatalogSchema.parse(options.catalog ?? mobileCatalog);
  const inference = createNativeInference(runtime);
  const pollMs = options.pollIntervalMs ?? 750;
  const timeoutMs = options.preparationTimeoutMs ?? 30 * 60 * 1000;
  if (
    !Number.isFinite(pollMs) ||
    pollMs < 10 ||
    pollMs > 60000 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 24 * 60 * 60 * 1000
  )
    throw new GezelSdkError('Invalid preparation polling or time budget', {
      code: 'invalid_request',
    });
  const downloads = async () =>
    MobileModelDownloadsSchema.parse(await runtime.listModelDownloads()).downloads;
  const manager = createModelManager({
    cancellation: 'download',
    async list({ signal }) {
      signal?.throwIfAborted();
      const [base, inventory, pending, providers] = await Promise.all([
        listModels(inference),
        runtime.listModels().then((value) => MobileModelInventorySchema.parse(value)),
        downloads(),
        inference.providers(),
      ]);
      signal?.throwIfAborted();
      const llama = providers.find((provider) => provider.id === 'llama-cpp');
      const result: ModelListEntry[] = base.data.map((model) => {
        const installed = inventory.models.find((entry) => `llama-cpp:${entry.id}` === model.id);
        const item =
          installed?.source && catalog.find((entry) => sameSource(entry.source, installed.source!));
        return item ? { ...model, aliases: [`catalog:${item.source.catalogId}`] } : model;
      });
      if (llama)
        for (const item of catalog) {
          if (
            inventory.models.some((model) => model.source && sameSource(item.source, model.source))
          )
            continue;
          const limits = resolveMobileInferenceLimits(llama);
          const fits =
            inventory.memoryBudgetBytes === undefined ||
            item.approxSizeBytes + 512 * 1024 ** 2 <= inventory.memoryBudgetBytes;
          const active = pending.find(
            (job) =>
              sameSource(item.source, job.source) &&
              ['queued', 'downloading', 'verifying'].includes(job.state),
          );
          // Inference can be unavailable because no weights are installed yet.
          // Catalog preparation is independent; native installation enforces admission.
          result.push({
            id: `catalog:${item.source.catalogId}`,
            object: 'model',
            created: 0,
            owned_by: 'llama-cpp',
            name: item.name,
            locality: 'on-device',
            preparation: 'app-download',
            download_bytes: item.approxSizeBytes,
            context_window: limits.contextSize,
            max_output_tokens: limits.maxTokens,
            availability: !fits ? 'unavailable' : active ? 'downloading' : 'download-required',
            reason_code: !fits ? 'insufficient_memory' : 'model_download_required',
            unavailable_reason: !fits
              ? 'This model exceeds the device memory budget'
              : 'Prepare this model to use it',
            recovery_actions: !fits ? ['choose-model'] : ['prepare'],
            capabilities: { ...llama.capabilities, tools: false, structuredOutput: false },
            supported_options: ['model', 'messages', 'stream', 'max_tokens'],
          });
        }
      return result;
    },
    async prepare(id, opts) {
      const releaseMonitor = acquireSuspendMonitor();
      const timeout = createAwakeTimeout(timeoutMs);
      const signal = AbortSignal.any([opts.signal, timeout.signal]);
      try {
        return await prepare(id, { ...opts, signal });
      } catch (error) {
        if (timeout.signal.aborted && !opts.signal.aborted)
          throw new GezelSdkError('Model preparation exceeded its awake-time budget', {
            code: 'timeout',
            cause: error,
          });
        throw error;
      } finally {
        timeout.dispose();
        releaseMonitor();
      }
    },
  });
  async function prepare(
    id: string,
    opts: PrepareModelOptions & { signal: AbortSignal },
  ): Promise<string> {
    const signal = opts.signal;
    let downloadId: string | undefined;
    let resolving = false;
    let preparing = false;
    let cancelTask: Promise<void> = Promise.resolve();
    const cancel = async () => {
      if (resolving) await runtime.cancelModelSourceResolution();
      if (preparing) await runtime.cancelProviderPreparation({ providerId: 'android-mlkit' });
      if (downloadId) await runtime.cancelModelDownload({ id: downloadId });
    };
    // Cleanup failure must remain visible even when the original operation was cancelled.
    const cancelOwned = async () => {
      try {
        await cancel();
      } catch (cause) {
        throw new GezelSdkError('Could not cancel native model preparation', {
          code: 'cleanup_failed',
          cause,
        });
      }
    };
    const abort = () => {
      cancelTask = cancel();
      void cancelTask.catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      const selected = await manager.inspect(id, { signal });
      if (!selected || selected.availability === 'unavailable')
        throw new GezelSdkError(selected?.unavailable_reason ?? 'Choose a model in the catalog', {
          code: selected?.reason_code ?? 'model_unavailable',
        });
      signal.throwIfAborted();
      if (id === 'android-mlkit:android-mlkit') {
        preparing = true;
        notify(opts.onProgress, {
          phase: 'preparing',
          message: 'Preparing the Android system model',
        });
        await runtime.prepareProvider({ providerId: 'android-mlkit' });
        signal.throwIfAborted();
        return id;
      }
      const model = catalog.find((entry) => `catalog:${entry.source.catalogId}` === id);
      if (!model)
        throw new GezelSdkError('This model must be prepared in system settings', {
          code: 'system_preparation_required',
        });
      let download = (await downloads()).find((job) => sameSource(model.source, job.source));
      signal.throwIfAborted();
      if (download && ['paused', 'failed'].includes(download.state)) {
        downloadId = download.id;
        download = MobileModelDownloadSchema.parse(
          field(await runtime.resumeModelDownload({ id: downloadId }), 'download'),
        );
        if (download.id !== downloadId)
          throw new GezelSdkError('Resumed download identity changed', {
            code: 'invalid_response',
          });
      } else if (!download) {
        resolving = true;
        notify(opts.onProgress, { phase: 'resolving', message: 'Checking the model download' });
        const source = MobileModelSourceSchema.parse(
          field(await runtime.resolveModelSource({ source: model.source }), 'source'),
        );
        resolving = false;
        signal.throwIfAborted();
        if (!sameSource(model.source, source))
          throw new GezelSdkError('Resolved model identity changed', { code: 'invalid_response' });
        download = MobileModelDownloadSchema.parse(
          field(await runtime.startModelDownload({ source, name: model.name }), 'download'),
        );
      }
      downloadId = download.id;
      while (true) {
        signal.throwIfAborted();
        if (!sameSource(model.source, download.source) || download.id !== downloadId)
          throw new GezelSdkError('Download identity changed', { code: 'invalid_response' });
        if (download.state === 'complete') {
          if (!download.modelId)
            throw new GezelSdkError('Completed download has no installed model', {
              code: 'invalid_response',
            });
          return `llama-cpp:${download.modelId}`;
        }
        if (download.state === 'failed')
          throw new GezelSdkError(download.error ?? 'Model download failed', {
            code: 'model_download_failed',
          });
        if (download.state === 'paused')
          throw new GezelSdkError('Model download paused; resume from an explicit prepare action', {
            code: 'download_paused',
          });
        notify(opts.onProgress, {
          phase: download.state === 'verifying' ? 'verifying' : 'downloading',
          message: `Preparing ${model.name}`,
          bytesWritten: download.downloadedBytes,
          totalBytes: download.source.sizeBytes,
        });
        await abortableDelay(pollMs, signal);
        const next = (await downloads()).find((job) => job.id === downloadId);
        if (!next)
          throw new GezelSdkError('Model download disappeared', { code: 'model_download_failed' });
        download = next;
      }
    } finally {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) {
        // A queued start can return its ID after abort; cancel again after it settles.
        await cancelTask.catch(() => {});
        await cancelOwned();
      }
    }
  }
  return manager;
}
