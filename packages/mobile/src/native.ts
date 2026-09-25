import { GezelRuntime, type GezelRuntimePlugin } from '@bendyline/gezel-capacitor';
import {
  type NativeInferencePlugin,
  createNativeInference,
} from '@bendyline/gezel/mobile-inference';
import {
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
  type MobileProviderId,
} from '@bendyline/gezel/mobile-providers';
import type {
  PortableFileSystem,
  PortableInference,
  PortableSpeech,
} from '@bendyline/gezel/runtime';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { type ExportFilePlugin, type ExportedFile, saveNativeExport } from './export-file.js';
import type { PublishHtmlPreview } from './html-preview.js';
import { type ProductFilePlugin, createNativeProductFiles } from './product-files.js';
import { createNativeSpeech } from './speech.js';

export type { MobileModel } from '@bendyline/gezel/schemas';
export type ModelInventory = MobileModelInventory;

export interface GezelMobilePlugin
  extends NativeInferencePlugin,
    ProductFilePlugin,
    ExportFilePlugin {
  previewAvailability?(): Promise<{ available: boolean }>;
  publishHtmlPreview?(options: { html: string }): Promise<{ id: string; url: string }>;
  removeHtmlPreview?(options: { id: string }): Promise<void>;
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
  prepareProvider(options: { providerId: MobileProviderId }): Promise<void>;
  cancelProviderPreparation(options: { providerId: MobileProviderId }): Promise<void>;
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
  const runtime: GezelRuntimePlugin | GezelMobilePlugin =
    nativePlugin === plugin ? GezelRuntime : nativePlugin;
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
          await runtime.resolveModelSource({
            source: MobileModelSourceIdentitySchema.parse(source),
          })
        ).source,
      ),
    cancelModelSourceResolution: async () => {
      await runtime.cancelModelSourceResolution();
    },
    listModelDownloads: async () =>
      MobileModelDownloadsSchema.parse(await runtime.listModelDownloads()).downloads,
    startModelDownload: async (source, name) =>
      MobileModelDownloadSchema.parse(
        (
          await runtime.startModelDownload({
            source: MobileModelSourceSchema.parse(source),
            name,
          })
        ).download,
      ),
    resumeModelDownload: async (id) =>
      MobileModelDownloadSchema.parse((await runtime.resumeModelDownload({ id })).download),
    cancelModelDownload: async (id) => {
      await runtime.cancelModelDownload({ id });
    },
    removeModelDownload: async (id) => {
      await runtime.removeModelDownload({ id });
    },
    saveExportedFile: (file) => saveNativeExport(nativePlugin, file),
    inference: createNativeInference(runtime),
    listModels: async () => MobileModelInventorySchema.parse(await runtime.listModels()),
    importModel: async () => {
      const { model } = await runtime.importModel();
      return { model: model === null ? null : MobileModelSchema.parse(model) };
    },
    selectModel: async (id) => ({
      model: MobileModelSchema.parse((await runtime.selectModel({ id })).model),
    }),
    removeModel: async (id) => {
      await runtime.removeModel({ id });
    },
    prepareProvider: async (providerId) => {
      await runtime.prepareProvider({ providerId });
    },
    cancelProviderPreparation: async (providerId) => {
      await runtime.cancelProviderPreparation({ providerId });
    },
  };
}

export function isNativeHost(): boolean {
  return Capacitor.isNativePlatform();
}
