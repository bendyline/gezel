/**
 * MemorySecretStore — secrets that live only as long as this process.
 *
 * The embedded inference profile (an app hosting Gezel for its own model
 * calls) keeps no credentials, so it must not open the OS keychain or write an
 * encrypted secrets file into the app's home. Subsystems that are constructed
 * but never started in that profile still take a `SecretStore`; this one gives
 * them a working, empty store with nothing at rest.
 */

import {
  type SecretKey,
  type SecretStore,
  type SecretStoreBackend,
  stringifySecretKey,
  toolsetKeyPrefix,
} from './types.js';

export class MemorySecretStore implements SecretStore {
  readonly backend: SecretStoreBackend = 'memory';

  private readonly entries = new Map<string, string>();

  async get(key: SecretKey): Promise<string | null> {
    return this.entries.get(stringifySecretKey(key)) ?? null;
  }

  async has(key: SecretKey): Promise<boolean> {
    return this.entries.has(stringifySecretKey(key));
  }

  async set(key: SecretKey, value: string): Promise<void> {
    this.entries.set(stringifySecretKey(key), value);
  }

  async delete(key: SecretKey): Promise<void> {
    this.entries.delete(stringifySecretKey(key));
  }

  async listForToolset(toolsetId: string): Promise<string[]> {
    const prefix = toolsetKeyPrefix(toolsetId);
    const fieldIds: string[] = [];
    for (const name of this.entries.keys()) {
      if (name.startsWith(prefix)) fieldIds.push(name.slice(prefix.length));
    }
    return fieldIds;
  }
}
