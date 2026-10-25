import { describe, expect, it, vi } from 'vitest';
import { GezelApp } from './client.js';
import { authorize } from './connect.js';
import { requestScopes } from './grant-flow.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function sse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

describe('ImagesClient', () => {
  it('streams progress, returns PNG bytes, and sends the wire request', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const app = new GezelApp({
      baseUrl: 'http://127.0.0.1:1234/',
      token: 'app-token',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return sse([
          { type: 'progress', phase: 'loading_model', step: 0, total_steps: 0 },
          { type: 'progress', phase: 'sampling', step: 2, total_steps: 4, seconds_per_step: 1.8 },
          {
            type: 'done',
            b64_png: base64(PNG),
            width: 1024,
            height: 768,
            seed: 7,
            model: 'sd-cpp:flux-2-klein-4b-q4',
            steps: 4,
            duration_ms: 12100,
          },
        ]);
      },
    });
    const progress: unknown[] = [];
    const image = await app.images.generate(
      { prompt: 'a lighthouse', model: 'sd-cpp:flux-2-klein-4b-q4', aspectRatio: '4:3', seed: 7 },
      { onProgress: (p) => progress.push(p) },
    );
    expect(image).toEqual({
      png: PNG,
      width: 1024,
      height: 768,
      seed: 7,
      model: 'sd-cpp:flux-2-klein-4b-q4',
      steps: 4,
      durationMs: 12100,
    });
    expect(progress).toEqual([
      { phase: 'loading_model', step: 0, totalSteps: 0 },
      { phase: 'sampling', step: 2, totalSteps: 4, secondsPerStep: 1.8 },
    ]);
    expect(calls[0]!.url).toBe('http://127.0.0.1:1234/v1/images/generations');
    expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe('Bearer app-token');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      prompt: 'a lighthouse',
      model: 'sd-cpp:flux-2-klein-4b-q4',
      aspect_ratio: '4:3',
      seed: 7,
    });
  });

  it('turns a stream error into a coded SDK error, and a missing scope into missing_scope', async () => {
    const failing = new GezelApp({
      baseUrl: 'http://127.0.0.1:1234',
      token: 't',
      fetch: async () =>
        sse([
          {
            type: 'error',
            error: { code: 'image_capacity', message: 'Not enough graphics memory' },
          },
        ]),
    });
    await expect(failing.images.generate({ prompt: 'x' })).rejects.toMatchObject({
      code: 'image_capacity',
    });
    const unscoped = new GezelApp({
      baseUrl: 'http://127.0.0.1:1234',
      token: 't',
      fetch: async () =>
        Response.json(
          { error: { code: 'missing_scope:images', message: 'missing_scope:images' } },
          { status: 403 },
        ),
    });
    await expect(unscoped.images.models()).rejects.toMatchObject({ code: 'missing_scope:images' });
  });

  it('reports a Gezel that predates image generation as unsupported', async () => {
    const health = (body: unknown) =>
      new GezelApp({
        baseUrl: 'http://127.0.0.1:1234',
        token: 't',
        fetch: async () => Response.json(body),
      });
    expect(await health({ ok: true }).images.support()).toEqual({
      supported: false,
      available: false,
    });
    expect(await health({ ok: true, images: { available: true } }).images.support()).toEqual({
      supported: true,
      available: true,
    });
  });
});

describe('adding the images scope', () => {
  it('upgrades in place: the current token asks, the app switches on approval', async () => {
    const seen: Array<{ path: string; auth: string | null; body?: unknown }> = [];
    const save = vi.fn();
    const fetchImpl: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      seen.push({
        path,
        auth: new Headers(init?.headers).get('authorization'),
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (path === '/api/health') return Response.json({ ok: true, images: { available: true } });
      if (path === '/v1/apps/register') {
        return Response.json(
          {
            grantRequestId: 'g1',
            status: 'pending',
            verificationRequired: true,
            verificationCode: 'ABC-123',
          },
          { status: 201 },
        );
      }
      if (path === '/v1/apps/grant/g1') return Response.json({ status: 'approved', token: 'new' });
      return Response.json({ object: 'list', data: [] });
    };
    const app = new GezelApp({ baseUrl: 'http://127.0.0.1:1234', token: 'old', fetch: fetchImpl });
    const showCode = vi.fn();
    await app.requestScopes({
      appId: 'docblocks',
      appName: 'DocBlocks',
      scopes: ['openai', 'images'],
      onVerificationCode: showCode,
      tokenStorage: { save },
    });
    expect(showCode).toHaveBeenCalledWith('ABC-123');
    expect(save).toHaveBeenCalledWith('docblocks', 'new');
    const register = seen.find((call) => call.path === '/v1/apps/register');
    expect(register?.auth).toBe('Bearer old');
    expect(register?.body).toMatchObject({ scopes: ['openai', 'images'] });
    expect(seen.some((call) => call.path.endsWith('/token'))).toBe(false);

    await app.images.models();
    expect(seen.at(-1)).toMatchObject({ path: '/v1/images/models', auth: 'Bearer new' });
  });

  it('never revokes or registers against a Gezel that predates images', async () => {
    const paths: string[] = [];
    const oldGezel: typeof fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === '/api/health') return Response.json({ ok: true });
      // An older daemon's UI shell answers unknown paths with HTML.
      return new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } });
    };
    await expect(
      requestScopes(
        { baseUrl: 'http://127.0.0.1:1234', token: 'old', fetch: oldGezel },
        {
          appId: 'docblocks',
          appName: 'DocBlocks',
          scopes: ['openai', 'images'],
          onVerificationCode: () => {},
        },
      ),
    ).rejects.toMatchObject({ code: 'images_unsupported' });
    await expect(
      authorize({
        appId: 'docblocks',
        appName: 'DocBlocks',
        scopes: ['openai', 'images'],
        existingToken: 'old',
        baseUrl: 'http://127.0.0.1:1234',
        fetch: oldGezel,
        onVerificationCode: () => {},
      }),
    ).rejects.toMatchObject({ code: 'images_unsupported' });
    expect(paths).toEqual(['/api/health', '/api/health']);
  });

  it('names a daemon that cannot add to a grant', async () => {
    const fetchImpl: typeof fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/health') return Response.json({ ok: true, images: { available: true } });
      return Response.json({ error: 'already_connected' }, { status: 409 });
    };
    await expect(
      requestScopes(
        { baseUrl: 'http://127.0.0.1:1234', token: 'old', fetch: fetchImpl },
        {
          appId: 'docblocks',
          appName: 'DocBlocks',
          scopes: ['openai', 'images'],
          onVerificationCode: () => {},
        },
      ),
    ).rejects.toMatchObject({ code: 'scope_upgrade_unsupported' });
  });
});
