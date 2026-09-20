import type { MobileHost } from './native.js';
import type { MobileStorage } from './runtime/index.js';

/** Browser previews use their own durable database; never the native app's files. */
function browserStorage(): MobileStorage {
  let database: Promise<IDBDatabase> | undefined;
  let expected: string | null | undefined;
  function open(): Promise<IDBDatabase> {
    database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('gezel-mobile-preview', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('documents');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Cannot open local storage'));
      request.onblocked = () => reject(new Error('Close other preview tabs to open local storage'));
    });
    return database;
  }
  return {
    async load() {
      const db = await open();
      return new Promise<string | null>((resolve, reject) => {
        const tx = db.transaction('documents', 'readonly');
        const read = tx.objectStore('documents').get('state');
        tx.oncomplete = () => {
          if (read.result !== undefined && typeof read.result !== 'string') {
            reject(new Error('The saved preview state is unreadable'));
          } else {
            expected = read.result ?? null;
            resolve(expected!);
          }
        };
        tx.onabort = () => reject(tx.error ?? new Error('Cannot read local storage'));
      });
    },
    async save(data) {
      const db = await open();
      return new Promise<void>((resolve, reject) => {
        if (expected === undefined) {
          reject(new Error('Open saved conversations before writing'));
          return;
        }
        const tx = db.transaction('documents', 'readwrite');
        const store = tx.objectStore('documents');
        const read = store.get('state');
        let conflict = false;
        read.onsuccess = () => {
          if ((read.result ?? null) !== expected) {
            conflict = true;
            tx.abort();
          } else store.put(data, 'state');
        };
        tx.oncomplete = () => {
          expected = data;
          resolve();
        };
        tx.onabort = () =>
          reject(
            conflict
              ? new Error(
                  'Conversations changed in another preview tab. Reload this tab before editing.',
                )
              : (tx.error ?? new Error('Cannot save local storage')),
          );
      });
    },
  };
}

export function createBrowserHost(): MobileHost {
  const unavailable = async (): Promise<never> => {
    throw new Error('Open the installed mobile app to use a model on this device.');
  };
  return {
    native: false,
    storage: browserStorage(),
    inference: {
      providers: async () => [
        {
          id: 'llama-cpp',
          name: 'Imported model',
          locality: 'on-device',
          availability: 'unavailable',
          reason: 'Open the installed mobile app to use a model on this device.',
          contextTokens: 2048,
          maxOutputTokens: 256,
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
