import { browserDatabase, createBrowserProductFiles } from './browser-files.js';
import { saveBrowserExport } from './export-file.js';
import type { MobileHost } from './native.js';

export function createBrowserHost(): MobileHost {
  const open = browserDatabase();
  const unavailable = async (): Promise<never> => {
    throw new Error('Open the installed mobile app to use a model on this device.');
  };
  return {
    native: false,
    resolveModelSource: unavailable,
    cancelModelSourceResolution: async () => {},
    listModelDownloads: async () => [],
    startModelDownload: unavailable,
    resumeModelDownload: unavailable,
    cancelModelDownload: unavailable,
    removeModelDownload: unavailable,
    saveExportedFile: saveBrowserExport,
    files: createBrowserProductFiles(open),
    inference: {
      models: async () => ({ models: [] }),
      providers: async () => [
        {
          id: 'llama-cpp',
          name: 'Imported model',
          locality: 'on-device',
          availability: 'unavailable',
          reason: 'Open the installed mobile app to use a model on this device.',
          contextTokens: 8192,
          maxOutputTokens: 4096,
          capabilities: {
            text: true,
            tools: false,
            structuredOutput: false,
            images: false,
            foregroundOnly: true,
          },
        },
      ],
      generate: unavailable,
      cancel: async () => {},
    },
    listModels: async () => ({ models: [] }),
    importModel: unavailable,
    selectModel: unavailable,
    removeModel: unavailable,
    prepareProvider: unavailable,
    cancelProviderPreparation: unavailable,
  };
}
