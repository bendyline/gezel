import type { NativeInferencePlugin } from '@bendyline/gezel/mobile-inference';
import type {
  MobileModel,
  MobileModelDownload,
  MobileModelSource,
  MobileModelSourceIdentity,
  MobileProviderId,
} from '@bendyline/gezel/mobile-providers';

/** App-owned native runtime. Model IDs are opaque; JavaScript never supplies paths. */
export interface GezelRuntimePlugin extends NativeInferencePlugin {
  prepareProvider(options: { providerId: MobileProviderId }): Promise<void>;
  cancelProviderPreparation(options: { providerId: MobileProviderId }): Promise<void>;
  releaseModel(): Promise<void>;
  importModel(): Promise<{ model: MobileModel | null }>;
  selectModel(options: { id: string }): Promise<{ model: MobileModel }>;
  removeModel(options: { id: string }): Promise<void>;
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
}
