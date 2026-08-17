import { describe, expect, it, vi } from 'vitest';
import { CapacityDeniedError } from '../native/capacity-broker.js';
import {
  DEFAULT_REMOTE_CONCURRENCY,
  ModelNotLoadedRemotelyError,
  REMOTE_ADMISSION_CACHE_TTL_MS,
  RemoteGezelProvider,
} from './provider.js';

function doneResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function toolCallResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'data: {"type":"tool_call","calls":[{"id":"shell-1","name":"shell","arguments":"{\\"command\\":\\"pwd\\"}"}]}\n\n',
        ),
      );
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
    expect(provider.supportsExternalTools).toBe(true);
  });

  it('forwards external tool definitions into the remote capture session', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/v1/remote/admit')) {
        return admissionResponse('llama-cpp:qwen.gguf');
      }
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return toolCallResponse();
    }) as typeof fetch;
    const provider = new RemoteGezelProvider({
      remoteId: 'this-machine',
      label: 'This machine',
      baseUrl: 'https://127.0.0.1:6228',
      token: 'token',
      fetch: fetchImpl,
      modelPrefix: 'llama-cpp',
    });
    const session = await provider.createSession({
      systemMessage: 'system',
      model: 'qwen.gguf',
      externalTools: [
        { name: 'shell', description: 'Run a command', parameters: { type: 'object' } },
      ],
    });

    await session.sendAndWait('hello');

    expect(requests[0]).toMatchObject({ tools: [{ name: 'shell' }] });
    expect(session.capturedToolCalls?.()).toEqual([
      { id: 'shell-1', name: 'shell', arguments: '{"command":"pwd"}' },
    ]);
    await session.disconnect();
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

  it('forwards cancellation to remote model discovery', async () => {
    const requestSignal: { value: AbortSignal | undefined } = { value: undefined };
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestSignal.value = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal.value?.addEventListener('abort', () => reject(requestSignal.value?.reason), {
          once: true,
        });
      });
    }) as typeof fetch;
    const provider = new RemoteGezelProvider({
      remoteId: 'this-machine',
      label: 'This machine',
      baseUrl: 'https://127.0.0.1:6228',
      token: 'token',
      fetch: fetchImpl,
    });
    const controller = new AbortController();

    const pending = provider.listModels(controller.signal);
    expect(requestSignal.value).toBe(controller.signal);
    controller.abort(new DOMException('setup discovery timed out', 'AbortError'));

    await expect(pending).resolves.toEqual([]);
    expect(requestSignal.value?.aborted).toBe(true);
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

  it('refreshes admission after the short session-start cache expires', async () => {
    let requests = 0;
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchImpl = (async () => {
      requests += 1;
      return admissionResponse('llama-cpp:qwen.gguf', requests === 1 ? 65_536 : 131_072);
    }) as typeof fetch;
    const provider = new RemoteGezelProvider({
      remoteId: 'this-machine',
      label: 'This machine',
      baseUrl: 'https://127.0.0.1:6228',
      token: 'token',
      fetch: fetchImpl,
      modelPrefix: 'llama-cpp',
    });

    try {
      await expect(provider.prepareContextWindow('qwen.gguf')).resolves.toBe(65_536);
      await expect(provider.prepareContextWindow('qwen.gguf')).resolves.toBe(65_536);
      expect(requests).toBe(1);

      now += REMOTE_ADMISSION_CACHE_TTL_MS;
      await expect(provider.prepareContextWindow('qwen.gguf')).resolves.toBe(131_072);
      expect(requests).toBe(2);
    } finally {
      nowSpy.mockRestore();
    }
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

    const rejection = provider.prepareContextWindow();
    await expect(rejection).rejects.toBeInstanceOf(ModelNotLoadedRemotelyError);
    await expect(rejection).rejects.not.toBeInstanceOf(CapacityDeniedError);
  });

  it('reports a missing model in words the user can act on, not an HTTP status', async () => {
    // A raw `[remote] /v1/remote/admit returned HTTP 404
    // {"error":"model_not_loaded",...}` landed in the composer for a user whose
    // install default named a download that never finished. It is the one
    // broker rejection an ordinary person can actually fix.
    const fetchImpl = (async () =>
      Response.json(
        { error: 'model_not_loaded', model: 'llama-cpp:qwen3.6-27b-q8' },
        { status: 404 },
      )) as typeof fetch;
    const provider = new RemoteGezelProvider({
      remoteId: 'this-machine',
      label: 'This Linux device',
      baseUrl: 'https://127.0.0.1:6228',
      token: 'token',
      fetch: fetchImpl,
      modelPrefix: 'llama-cpp',
      defaultModel: 'qwen3.6-27b-q8',
    });

    let caught: unknown;
    try {
      await provider.prepareContextWindow();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ModelNotLoadedRemotelyError);
    const error = caught as ModelNotLoadedRemotelyError;
    expect(error.brokerModelId).toBe('llama-cpp:qwen3.6-27b-q8');
    expect(error.message).toContain('This Linux device');
    // The model half only — engine namespaces are our plumbing, not theirs.
    expect(error.message).toContain('"qwen3.6-27b-q8"');
    expect(error.message).toMatch(/Settings → Artificial Intelligence/);
    expect(error.message).not.toMatch(/404|model_not_loaded|admit/);
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

  it('forwards cancellation to remote context admission', async () => {
    const requestSignal: { value: AbortSignal | undefined } = { value: undefined };
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestSignal.value = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal.value?.addEventListener('abort', () => reject(requestSignal.value?.reason), {
          once: true,
        });
      });
    }) as typeof fetch;
    const provider = new RemoteGezelProvider({
      remoteId: 'this-machine',
      label: 'This machine',
      baseUrl: 'https://127.0.0.1:6228',
      token: 'token',
      fetch: fetchImpl,
      modelPrefix: 'llama-cpp',
    });
    const controller = new AbortController();

    const pending = provider.prepareContextWindow('qwen.gguf', controller.signal);
    expect(requestSignal.value).toBe(controller.signal);
    controller.abort(new DOMException('setup admission timed out', 'AbortError'));

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(requestSignal.value?.aborted).toBe(true);
  });
});
