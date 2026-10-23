import { describe, expect, it } from 'vitest';
import { RemoteImageProvider } from './remote-image.js';

function fakeServer(installed: string[]) {
  const generated: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/remote/image/models') {
      return Response.json({
        models: installed.map((id) => ({
          id,
          name: id,
          approxSizeBytes: 1,
          installedAt: '2026-10-18T00:00:00Z',
        })),
      });
    }
    if (path === '/v1/remote/image/generate') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      generated.push(body);
      return Response.json({
        png: '',
        meta: {
          model: body.model ?? 'server-default',
          seed: 1,
          steps: 4,
          widthPx: 8,
          heightPx: 8,
          durationMs: 1,
        },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, generated };
}

function provider(fetchImpl: typeof fetch, configured?: string) {
  return new RemoteImageProvider({
    remoteId: 'this-machine',
    label: 'This machine',
    baseUrl: 'https://127.0.0.1:6229',
    token: 't',
    fetch: fetchImpl,
    defaultModelId: async () => configured,
  });
}

describe('RemoteImageProvider default model', () => {
  it("runs the person's configured default on the broker when a request names none", async () => {
    const server = fakeServer(['animagine-xl-4', 'moss-image-sft-q4']);
    const remote = provider(server.fetchImpl, 'moss-image-sft-q4');

    expect(await remote.resolveDefaultModelId()).toBe('moss-image-sft-q4');
    await remote.generate({ prompt: 'a sign' });
    expect(server.generated[0]?.model).toBe('moss-image-sft-q4');
  });

  it('falls back to the first installed model when the configured one is not there', async () => {
    const server = fakeServer(['animagine-xl-4', 'sd-turbo']);
    const remote = provider(server.fetchImpl, 'moss-image-sft-q4');

    expect(await remote.resolveDefaultModelId()).toBe('animagine-xl-4');
  });

  it('passes an explicit model through untouched', async () => {
    const server = fakeServer(['animagine-xl-4', 'moss-image-sft-q4']);
    await provider(server.fetchImpl, 'moss-image-sft-q4').generate({
      prompt: 'a sign',
      model: 'remote:this-machine/animagine-xl-4',
    });
    expect(server.generated[0]?.model).toBe('animagine-xl-4');
  });
});
