import { describe, expect, it } from 'vitest';
import { MemorySecretStore } from './memory-store.js';

describe('MemorySecretStore', () => {
  it('keeps values for the life of the store and nowhere else', async () => {
    const store = new MemorySecretStore();
    const key = { kind: 'providerCredential', name: 'openaiApiKey' } as const;

    expect(store.backend).toBe('memory');
    expect(await store.get(key)).toBeNull();
    await store.set(key, 'sk-test');
    expect(await store.has(key)).toBe(true);
    expect(await store.get(key)).toBe('sk-test');
    // A second store is a different process's memory: nothing carries over.
    expect(await new MemorySecretStore().get(key)).toBeNull();

    await store.delete(key);
    expect(await store.has(key)).toBe(false);
  });

  it('lists only the named toolset', async () => {
    const store = new MemorySecretStore();
    await store.set({ kind: 'toolset', toolsetId: 'mail', fieldId: 'user' }, 'a');
    await store.set({ kind: 'toolset', toolsetId: 'mail', fieldId: 'password' }, 'b');
    await store.set({ kind: 'toolset', toolsetId: 'mailer', fieldId: 'token' }, 'c');

    expect((await store.listForToolset('mail')).sort()).toEqual(['password', 'user']);
  });
});
