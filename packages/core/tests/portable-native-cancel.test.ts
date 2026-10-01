import { describe, expect, it, vi } from 'vitest';
import { GezelClient } from '../../client/src/client.js';
import { type NativeInferencePlugin, createNativeInference } from '../src/mobile/inference.js';
import type { PortableFileEntry, PortableFileSystem } from '../src/runtime/files.js';
import { PortableProductService } from '../src/runtime/product-service.js';
import { PortableStore } from '../src/runtime/store.js';

/**
 * Stopping a phone reply goes through the real native inference adapter, not a
 * stand-in: the product runtime, the adapter, and a plugin that streams until
 * it is cancelled, as the Android and iOS hosts do.
 */

class MemoryFiles implements PortableFileSystem {
  entries = new Map<string, Uint8Array | null>([['', null]]);
  async read(path: string) {
    const value = this.entries.get(path);
    return value ? value.slice() : null;
  }
  async mkdir(path: string) {
    for (let p = path; p; p = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '') {
      this.entries.set(p, null);
    }
  }
  async write(path: string, data: Uint8Array) {
    const slash = path.lastIndexOf('/');
    if (slash > 0) await this.mkdir(path.slice(0, slash));
    this.entries.set(path, data.slice());
  }
  async list(path: string) {
    const prefix = path ? `${path}/` : '';
    return [...this.entries]
      .filter(
        ([name]) =>
          name !== path && name.startsWith(prefix) && !name.slice(prefix.length).includes('/'),
      )
      .map(
        ([name, data]): PortableFileEntry => ({
          name: name.slice(prefix.length),
          isDirectory: data === null,
          size: data?.length ?? 0,
          mtime: Date.now(),
        }),
      );
  }
  async remove(path: string) {
    for (const name of this.entries.keys())
      if (name === path || name.startsWith(`${path}/`)) this.entries.delete(name);
  }
  async rename(from: string, to: string) {
    const values = [...this.entries].filter(
      ([name]) => name === from || name.startsWith(`${from}/`),
    );
    for (const [name, data] of values) this.entries.set(to + name.slice(from.length), data);
    await this.remove(from);
  }
}

const MODEL_ID = '0b0f5d5e-8c1a-4c55-9f5e-3a3f2d1c0b9a';

function streamingPlugin() {
  const listeners = new Map<string, Set<(event: never) => void>>();
  let active: { requestId: string; finish: (text: string) => void; text: string } | undefined;
  let idle: Promise<void> = Promise.resolve();
  let markIdle = () => {};
  const plugin: NativeInferencePlugin = {
    // Like the Android host: probes share the inference queue, so they wait
    // for a live generation to end.
    providers: async () => {
      await idle;
      return providerList();
    },
    listModels: async () => ({
      models: [{ id: MODEL_ID, name: 'model.gguf', sizeBytes: 100, contextTokens: 16384 }],
      selectedModelId: MODEL_ID,
    }),
    generate: vi.fn(
      (request: { requestId: string }) =>
        new Promise<Awaited<ReturnType<NativeInferencePlugin['generate']>>>((resolve) => {
          idle = new Promise((done) => {
            markIdle = done;
          });
          const run = {
            requestId: request.requestId,
            text: '',
            finish: (stopReason: string) => {
              markIdle();
              resolve({ text: run.text, stopReason: stopReason as 'stop' | 'cancelled' });
            },
          };
          active = run;
          const tick = setInterval(() => {
            if (active !== run) return clearInterval(tick);
            run.text += 'word ';
            for (const listener of listeners.get('chatDelta') ?? [])
              (listener as (event: { requestId: string; delta: string }) => void)({
                requestId: run.requestId,
                delta: 'word ',
              });
          }, 5);
        }),
    ) as NativeInferencePlugin['generate'],
    cancel: vi.fn(async ({ requestId }: { requestId: string }) => {
      if (active?.requestId !== requestId) return;
      const run = active;
      active = undefined;
      run.finish('cancelled');
    }),
    addListener: (async (event: string, callback: (event: never) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(callback);
      listeners.set(event, set);
      return { remove: async () => void set.delete(callback) };
    }) as NativeInferencePlugin['addListener'],
  };
  return plugin;
}

function providerList(): Awaited<ReturnType<NativeInferencePlugin['providers']>> {
  return {
    providers: [
      {
        id: 'llama-cpp',
        name: 'Imported model',
        locality: 'on-device',
        availability: 'available',
        contextTokens: 16384,
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
  };
}

describe('stopping a native phone reply', () => {
  it('reaches the native engine while the reply streams', async () => {
    const plugin = streamingPlugin();
    const store = new PortableStore({ files: new MemoryFiles() });
    const service = new PortableProductService(store, createNativeInference(plugin), 'test-token');
    await service.initialize();
    const client = new GezelClient({
      baseUrl: 'https://gezel.local',
      token: 'test-token',
      fetch: service.fetch,
    });
    const { gezels } = await client.listGezels();
    const session = await client.createChatSession({ gezelId: gezels[0]!.id });
    await client.sendToChatSession(session.id, { message: 'Write a very long journal.' });
    await vi.waitFor(() => expect(plugin.generate).toHaveBeenCalled());
    // The phone UI polls the model listing while a reply streams. Its provider
    // probe must not hold the routes behind the generation.
    const prompt = <T>(work: Promise<T>) =>
      Promise.race([
        work,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('route waited on the generation')), 1000),
        ),
      ]);
    await expect(prompt(client.listProviderModels('llama-cpp'))).resolves.toMatchObject({
      models: [expect.objectContaining({ id: MODEL_ID, maxOutputTokens: 4096 })],
    });
    await expect(prompt(client.getChatSessionInflight(session.id))).resolves.toMatchObject({
      inflight: expect.objectContaining({ userText: 'Write a very long journal.' }),
    });
    await expect(client.cancelChatSessionTurn(session.id)).resolves.toMatchObject({
      cancelled: true,
    });
    expect(plugin.cancel).toHaveBeenCalled();
    await vi.waitFor(() => expect(service.busy).toBe(false));
    const stopped = await client.getChatSession(session.id);
    expect(stopped.turnStartedAt).toBeUndefined();
    expect(
      stopped.messages.some(
        (m) => m.role === 'assistant' && m.status === 'interrupted' && m.stopReason === 'cancelled',
      ),
    ).toBe(true);
  });
});
