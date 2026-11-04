import type { PluginListenerHandle } from '@capacitor/core';

/** App-owned knowledge archive store. JavaScript names catalogs; native code owns paths. */
export interface GezelKnowledgePlugin {
  info(): Promise<{
    /** Where the worker reads archives in byte ranges; the root of the store. */
    baseUrl: string;
    /** Installed archives: each file is `<version>/catalog.gezk`. */
    catalogs: { id: string; files: string[] }[];
    downloading?: string;
  }>;
  install(options: {
    id: string;
    version: string;
    url: string;
    sha256: string;
    size: number;
  }): Promise<{ id: string }>;
  /** A profile's query model, into the same store under `queryModelStoreId`. */
  installModel(options: {
    id: string;
    files: readonly { name: string; url: string; sha256: string; size: number }[];
  }): Promise<{ id: string }>;
  /** A query's unit vector from an installed query model. */
  embed(options: { model: string; file: string; ids: readonly number[] }): Promise<{
    vector: number[];
  }>;
  cancelInstall(): Promise<void>;
  remove(options: { id: string }): Promise<void>;
  addListener(
    event: 'knowledgeDownload',
    listener: (event: { id: string; receivedBytes: number; totalBytes: number }) => void,
  ): Promise<PluginListenerHandle>;
}
