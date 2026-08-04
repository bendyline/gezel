import { describe, expect, it } from 'vitest';
import { RemoteGezelProvider } from './provider.js';

function doneResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('RemoteGezelProvider', () => {
  it('adds the local engine namespace for automatic machine-broker sessions', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
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
    await session.disconnect();
  });

  it('does not duplicate an engine namespace already present on the wire', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
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
});
