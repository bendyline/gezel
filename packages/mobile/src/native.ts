import {
  MobileInferenceBudgetSchema,
  type MobileModel,
  type MobileModelDownload,
  MobileModelDownloadSchema,
  MobileModelDownloadsSchema,
  type MobileModelInventory,
  MobileModelInventorySchema,
  MobileModelSchema,
  type MobileModelSource,
  type MobileModelSourceIdentity,
  MobileModelSourceIdentitySchema,
  MobileModelSourceSchema,
  type MobileProvider,
  type MobileProviderId,
  MobileProviderListSchema,
} from '@bendyline/gezel/mobile-providers';
import type {
  PortableFileSystem,
  PortableInference,
  PortableSpeech,
} from '@bendyline/gezel/runtime';
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import { type ExportFilePlugin, type ExportedFile, saveNativeExport } from './export-file.js';
import type { PublishHtmlPreview } from './html-preview.js';
import { type ProductFilePlugin, createNativeProductFiles } from './product-files.js';
import { createNativeSpeech } from './speech.js';

export type { MobileModel } from '@bendyline/gezel/schemas';
export type ModelInventory = MobileModelInventory;

export interface GezelMobilePlugin extends ProductFilePlugin, ExportFilePlugin {
  previewAvailability?(): Promise<{ available: boolean }>;
  publishHtmlPreview?(options: { html: string }): Promise<{ id: string; url: string }>;
  removeHtmlPreview?(options: { id: string }): Promise<void>;
  readState(): Promise<{ data: string | null }>;
  writeState(options: { data: string }): Promise<void>;
  listModels(): Promise<ModelInventory>;
  resolveModelSource(options: { source: MobileModelSourceIdentity }): Promise<{
    source: MobileModelSource;
  }>;
  cancelModelSourceResolution(): Promise<void>;
  listModelDownloads(): Promise<{ downloads: MobileModelDownload[] }>;
  startModelDownload(options: { source: MobileModelSource; name: string }): Promise<{
    download: MobileModelDownload;
  }>;
  resumeModelDownload(options: { id: string }): Promise<{ download: MobileModelDownload }>;
  cancelModelDownload(options: { id: string }): Promise<void>;
  removeModelDownload(options: { id: string }): Promise<void>;
  importModel(): Promise<{ model: MobileModel | null }>;
  selectModel(options: { id: string }): Promise<{ model: MobileModel }>;
  removeModel(options: { id: string }): Promise<void>;
  providers(): Promise<{ providers: MobileProvider[] }>;
  prepareProvider(options: { providerId: MobileProviderId }): Promise<void>;
  cancelProviderPreparation(options: { providerId: MobileProviderId }): Promise<void>;
  generate(options: {
    requestId: string;
    providerId: MobileProviderId;
    modelId?: string;
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
  speech?: PortableSpeech;
  previewAvailability?(): Promise<boolean>;
  publishHtmlPreview?: PublishHtmlPreview;
  native: boolean;
  files: PortableFileSystem;
  inference: PortableInference;
  listModels(): Promise<ModelInventory>;
  resolveModelSource(source: MobileModelSourceIdentity): Promise<MobileModelSource>;
  cancelModelSourceResolution(): Promise<void>;
  listModelDownloads(): Promise<MobileModelDownload[]>;
  startModelDownload(source: MobileModelSource, name: string): Promise<MobileModelDownload>;
  resumeModelDownload(id: string): Promise<MobileModelDownload>;
  cancelModelDownload(id: string): Promise<void>;
  removeModelDownload(id: string): Promise<void>;
  importModel(): Promise<{ model: MobileModel | null }>;
  selectModel(id: string): Promise<{ model: MobileModel }>;
  removeModel(id: string): Promise<void>;
  prepareProvider(providerId: MobileProviderId): Promise<void>;
  cancelProviderPreparation(providerId: MobileProviderId): Promise<void>;
  saveExportedFile(file: ExportedFile): Promise<void>;
}

const plugin = registerPlugin<GezelMobilePlugin>('GezelMobile');

export function createNativeHost(nativePlugin: GezelMobilePlugin = plugin): MobileHost {
  const runs = new Map<string, { cancelled: boolean; started: boolean; released: Promise<void> }>();
  return {
    native: true,
    speech: createNativeSpeech(),
    previewAvailability: async () =>
      (await nativePlugin.previewAvailability?.())?.available === true,
    publishHtmlPreview: async (html) => {
      if (!nativePlugin.publishHtmlPreview || !nativePlugin.removeHtmlPreview)
        throw new Error('Safe page previews are unavailable in this build');
      const result = await nativePlugin.publishHtmlPreview({ html });
      if (
        !/^[0-9a-f-]{36}$/.test(result.id) ||
        !new RegExp(
          `^(https|capacitor)://localhost/__gezel_preview/${result.id}/index\\.html$`,
        ).test(result.url)
      )
        throw new Error('The native preview returned an invalid address');
      return {
        url: result.url,
        dispose: () => {
          void nativePlugin.removeHtmlPreview!({ id: result.id }).catch(() => {});
        },
      };
    },
    files: createNativeProductFiles(nativePlugin),
    resolveModelSource: async (source) =>
      MobileModelSourceSchema.parse(
        (
          await nativePlugin.resolveModelSource({
            source: MobileModelSourceIdentitySchema.parse(source),
          })
        ).source,
      ),
    cancelModelSourceResolution: async () => {
      await nativePlugin.cancelModelSourceResolution();
    },
    listModelDownloads: async () =>
      MobileModelDownloadsSchema.parse(await nativePlugin.listModelDownloads()).downloads,
    startModelDownload: async (source, name) =>
      MobileModelDownloadSchema.parse(
        (
          await nativePlugin.startModelDownload({
            source: MobileModelSourceSchema.parse(source),
            name,
          })
        ).download,
      ),
    resumeModelDownload: async (id) =>
      MobileModelDownloadSchema.parse((await nativePlugin.resumeModelDownload({ id })).download),
    cancelModelDownload: async (id) => {
      await nativePlugin.cancelModelDownload({ id });
    },
    removeModelDownload: async (id) => {
      await nativePlugin.removeModelDownload({ id });
    },
    saveExportedFile: (file) => saveNativeExport(nativePlugin, file),
    inference: {
      models: async () => MobileModelInventorySchema.parse(await nativePlugin.listModels()),
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
          const budget = MobileInferenceBudgetSchema.parse({
            contextSize: request.contextSize ?? 4096,
            maxTokens: request.maxTokens ?? 1024,
          });
          if (request.providerId === 'llama-cpp') MobileModelSchema.shape.id.parse(request.modelId);
          else if (request.modelId !== undefined && request.modelId !== request.providerId)
            throw new Error('The requested model is not available from this on-device provider');
          return await nativePlugin.generate({ ...request, ...budget });
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
