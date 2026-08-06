import { describe, expect, it } from 'vitest';
import { CapacityDeniedError } from '../native/capacity-broker.js';
import { DEFAULT_REMOTE_CONCURRENCY, RemoteGezelProvider } from './provider.js';

function doneResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function admissionResponse(model: string, contextWindow = 35_840): Response {
  return Response.json({ model, contextWindow });
}

describe('RemoteGezelProvider', () => {
  it('keeps client admission within the broker cap and reserves typed-chat headroom', () => {
    const provider = new RemoteGezelProvider({
      remoteId: 'this-machine',
      label: 'This machine',
      baseUrl: 'https://127.0.0.1:6228',
      token: 'token',
      fetch,
    });

    expect(provider.queue.concurrency).toBe(DEFAULT_REMOTE_CONCURRENCY);
    expect(provider.queue.backgroundConcurrency).toBe(DEFAULT_REMOTE_CONCURRENCY - 1);
  });

  it('re-reads broker inventory so a completed pull appears without reconnecting', async () => {
    let requests = 0;
    const fetchImpl = (async () => {
      requests += 1;
      const models = [{ id: 'llama-cpp:qwen.gguf', name: 'Qwen', modality: 'chat' as const }];
      if (requests > 1) {
        models.push({ id: 'llama-cpp:gemma.gguf', name: 'Gemma', modality: 'chat' });
      }
      return Response.json({ deviceId: 'broker', models });
    }) as typeof fetch;
    const provider = new RemoteGezelProvider({
      remoteId: 'this-machine',
      label: 'This machine',
      baseUrl: 'https://127.0.0.1:6228',
      token: 'token',
      fetch: fetchImpl,
    });

    await expect(provider.listModels()).resolves.toEqual([
      expect.objectContaining({ id: 'remote:this-machine/llama-cpp:qwen.gguf' }),
    ]);
    await expect(provider.listModels()).resolves.toEqual([
      expect.objectContaining({ id: 'remote:this-machine/llama-cpp:qwen.gguf' }),
      expect.objectContaining({ id: 'remote:this-machine/llama-cpp:gemma.gguf' }),
    ]);
    expect(requests).toBe(2);
  });

  it('adds the local engine namespace for automatic machine-broker sessions', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/v1/remote/admit')) {
        return admissionResponse('llama-cpp:qwen.gguf');
      }
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return doneResponse();
    }) as typeof fetch;
    const provider = new RemoteGezelProvider({
      remoteId: 'this-machine',
      label: 'This machine',
      baseUrl: 'https://127.0.0.1:6228',
      token: 'token',
      fetch: fetchImpl,
      modelPrefix: 'llama-cpp',
    });
    const session = await provider.createSession({ systemMessage: 'system', model: 'qwen.gguf' });

    await session.sendAndWait('hello');

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: 'llama-cpp:qwen.gguf' });
    expect(provider.getContextWindow()).toBe(35_840);
    expect(session.numCtx).toBe(35_840);
    await session.disconnect();
  });

  it('does not duplicate an engine namespace already present on the wire', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/v1/remote/admit')) return admissionResponse('mlx:qwen');
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return doneResponse();
    }) as typeof fetch;
    const provider = new RemoteGezelProvider({
      remoteId: 'this-machine',
      label: 'This machine',
      baseUrl: 'https://127.0.0.1:6228',
      token: 'token',
      fetch: fetchImpl,
      modelPrefix: 'mlx',
    });
    const session = await provider.createSession({ systemMessage: 'system', model: 'mlx:qwen' });

    await session.sendAndWait('hello');

    expect(requests[0]).toMatchObject({ model: 'mlx:qwen' });
    await session.disconnect();
  });

  it('refuses an old broker that cannot prove the 64K minimum', async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      if (String(url).endsWith('/v1/remote/admit')) {
        return Response.json({ error: 'not_found' }, { status: 404 });
      }
      return doneResponse();
    }) as typeof fetch;
    const provider = new RemoteGezelProvider({
      remoteId: 'this-machine',
      label: 'This machine',
      baseUrl: 'https://127.0.0.1:6228',
      token: 'token',
      fetch: fetchImpl,
      modelPrefix: 'llama-cpp',
      defaultModel: 'llama-cpp:qwen.gguf',
    });

    await expect(provider.prepareContextWindow()).rejects.toThrow(/cannot prove.*65,536-token/i);
    expect(provider.getContextWindow()).toBeUndefined();
  });

  it('preserves a broker context-capacity denial as a structured local error', async () => {
    const fetchImpl = (async () =>
      Response.json({ error: 'capacity_denied' }, { status: 503 })) as typeof fetch;
    const provider = new RemoteGezelProvider({
      remoteId: 'this-machine',
      label: 'This machine',
      baseUrl: 'https://127.0.0.1:6228',
      token: 'token',
      fetch: fetchImpl,
      modelPrefix: 'llama-cpp',
      defaultModel: 'llama-cpp:qwen.gguf',
    });

    await expect(provider.prepareContextWindow()).rejects.toBeInstanceOf(CapacityDeniedError);
  });

  it('does not disguise a model-not-loaded response as legacy compatibility', async () => {
    const fetchImpl = (async () =>
      Response.json({ error: 'model_not_loaded' }, { status: 404 })) as typeof fetch;
    const provider = new RemoteGezelProvider({
      remoteId: 'this-machine',
      label: 'This machine',
      baseUrl: 'https://127.0.0.1:6228',
      token: 'token',
      fetch: fetchImpl,
      defaultModel: 'llama-cpp:missing.gguf',
    });

    await expect(provider.prepareContextWindow()).rejects.toThrow(/model_not_loaded/);
  });

  it('waits through tenant saturation during context admission', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) {
        return Response.json(
          { error: 'tenant_concurrency_exceeded' },
          { status: 429, headers: { 'Retry-After': '0' } },
        );
      }
      return admissionResponse('mlx:qwen', 24_576);
    }) as typeof fetch;
    const provider = new RemoteGezelProvider({
      remoteId: 'this-machine',
      label: 'This machine',
      baseUrl: 'https://127.0.0.1:6228',
      token: 'token',
      fetch: fetchImpl,
      defaultModel: 'mlx:qwen',
    });

    await expect(provider.prepareContextWindow()).resolves.toBe(24_576);
    expect(calls).toBe(2);
  });
});
