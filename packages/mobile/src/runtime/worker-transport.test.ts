import type { MobileProvider } from '@bendyline/gezel/schemas';
import { afterEach, expect, it, vi } from 'vitest';
import type { MobileHost } from '../native.js';
import { createWorkerClient } from '../worker-client.js';
import type { FromWorker, ToWorker } from '../worker-protocol.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('carries provider and conversation operations through both sides of the worker protocol', async () => {
  const scope = globalThis as unknown as {
    onmessage: ((event: { data: ToWorker }) => void) | null;
  };
  let worker!: BridgeWorker;
  class BridgeWorker {
    onmessage: ((event: { data: FromWorker }) => void) | null = null;
    onerror: (() => void) | null = null;
    terminated = false;
    constructor() {
      worker = this;
    }
    postMessage(data: ToWorker) {
      queueMicrotask(() => {
        if (!this.terminated) scope.onmessage?.({ data });
      });
    }
    terminate() {
      this.terminated = true;
    }
  }
  vi.stubGlobal('Worker', BridgeWorker);
  vi.stubGlobal('onmessage', null);
  vi.stubGlobal('postMessage', (data: FromWorker) => {
    queueMicrotask(() => {
      if (!worker.terminated) worker.onmessage?.({ data });
    });
  });
  const provider: MobileProvider = {
    id: 'apple-foundation-models',
    name: 'Apple Intelligence',
    locality: 'on-device',
    availability: 'available',
    contextTokens: 4096,
    maxOutputTokens: 1024,
    capabilities: {
      text: true,
      tools: false,
      structuredOutput: false,
      images: false,
      foregroundOnly: true,
    },
  };
  let saved: string | null = null;
  const host: MobileHost = {
    native: true,
    storage: {
      load: async () => saved,
      save: async (data) => {
        saved = data;
      },
    },
    inference: {
      providers: async () => [provider],
      generate: vi.fn(async (request, onDelta) => {
        expect(request.providerId).toBe('apple-foundation-models');
        onDelta({ requestId: request.requestId, delta: 'A reply' });
        return { text: 'A reply', stopReason: 'stop' as const };
      }),
      cancel: vi.fn(async () => {}),
    },
    listModels: async () => ({ models: [] }),
    importModel: async () => ({ model: null }),
    selectModel: async () => {
      throw new Error('No models');
    },
    removeModel: async () => {},
    prepareProvider: async () => {},
    cancelProviderPreparation: async () => {},
  };
  const client = createWorkerClient(host);
  await vi.resetModules();
  await import('../runtime-worker.js');
  try {
    const listener = vi.fn();
    client.subscribe(listener);
    expect(await client.providers()).toEqual([provider]);
    await client.setProvider(provider.id);
    const sent = await client.send('Hello');
    expect(sent.state.sessions[0]!.messages[1]).toMatchObject({
      content: 'A reply',
      providerId: provider.id,
    });
    const firstId = sent.state.activeSessionId;
    await client.renameConversation(firstId, 'A saved conversation');
    const next = await client.newConversation();
    await client.selectConversation(firstId);
    await client.deleteConversation(next.state.activeSessionId);
    const snapshot = await client.retrySave();
    expect(snapshot.state.sessions).toHaveLength(1);
    expect(snapshot.state.sessions[0]!.title).toBe('A saved conversation');
    expect(JSON.parse(saved!)).toEqual(snapshot.state);
    expect(listener).toHaveBeenCalled();
    expect((await client.cancel()).activeRequestId).toBeNull();
  } finally {
    client.dispose();
  }
  await expect(client.providers()).rejects.toThrow('runtime has closed');
});
