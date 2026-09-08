import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GEZEL_VERSION } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningEngineService, startService } from '../service.js';

let service: RunningEngineService;
let home: string;
let baseUrl: string;
let httpFetch: typeof fetch;

const priorMock = process.env.GEZEL_MOCK_PROVIDER;
const priorSecrets = process.env.GEZEL_SECRETS_BACKEND;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  process.env.GEZEL_SECRETS_BACKEND = 'file';
  home = await mkdtemp(join(tmpdir(), 'gezel-machine-engine-'));
  service = await startService({ home, role: 'machine-engine' });
  baseUrl = `${service.cert ? 'https' : 'http'}://127.0.0.1:${service.port}`;
  httpFetch = service.cert ? createTrustingFetch({ cert: service.cert.certPem }) : fetch;
}, 60_000);

afterAll(async () => {
  await service?.stop();
  await rm(home, { recursive: true, force: true }).catch(() => undefined);
  if (priorMock === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMock;
  if (priorSecrets === undefined) delete process.env.GEZEL_SECRETS_BACKEND;
  else process.env.GEZEL_SECRETS_BACKEND = priorSecrets;
}, 30_000);

function machineFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${service.clientToken}`);
  return httpFetch(`${baseUrl}${path}`, { ...init, headers });
}

describe('machine-engine service boundary', () => {
  it('publishes the installer health contract, runtime role, and public identity', async () => {
    expect(service.context.serviceRole).toBe('machine-engine');
    await expect(readFile(join(home, 'runtime', 'service-role'), 'utf8')).resolves.toBe(
      'machine-engine\n',
    );
    const health = await httpFetch(`${baseUrl}/api/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      ok: true,
      version: GEZEL_VERSION,
      serviceRole: 'machine-engine',
    });
    const identity = await httpFetch(`${baseUrl}/v1/identity`);
    expect(identity.status).toBe(200);
    await expect(identity.json()).resolves.toMatchObject({ serviceRole: 'machine-engine' });
  });

  it('allows inference and managed model lifecycle with the runtime token', async () => {
    expect((await machineFetch('/v1/remote/models')).status).toBe(200);
    expect((await machineFetch('/v1/remote/manage/llama-cpp/models')).status).toBe(200);
    expect((await machineFetch('/v1/remote/manage/engines/status')).status).toBe(200);
    expect((await machineFetch('/v1/remote/manage/engines/llama-cpp/model-context')).status).toBe(
      200,
    );
    expect((await machineFetch('/v1/remote/manage/system/memory/usage')).status).toBe(200);
    expect((await machineFetch('/v1/remote/manage/image-gen/models')).status).toBe(200);
    expect((await machineFetch('/v1/remote/manage/video-gen/models')).status).toBe(200);
    expect((await machineFetch('/v1/remote/manage/audio/stt/models')).status).toBe(200);
    expect((await machineFetch('/v1/remote/manage/model-fitness')).status).toBe(200);
  });

  it.each([
    '/v1/remote/manage/image-gen/models',
    '/v1/remote/manage/audio/stt/models',
    '/v1/remote/manage/audio/tts/models',
  ])('rejects encoded model-id traversal on %s', async (modelsPath) => {
    const response = await machineFetch(`${modelsPath}/..%2F..`, { method: 'DELETE' });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'invalid-model-id' });
  });

  it('does not let an ordinary paired-inference token administer machine models', async () => {
    const paired = await service.context.tokenStore.issue({
      appId: 'paired-test-device',
      appName: 'Paired test device',
      scopes: ['remote-inference'],
    });
    const inference = await httpFetch(`${baseUrl}/v1/remote/models`, {
      headers: { Authorization: `Bearer ${paired.token}` },
    });
    const management = await httpFetch(`${baseUrl}/v1/remote/manage/llama-cpp/models`, {
      headers: { Authorization: `Bearer ${paired.token}` },
    });
    expect(inference.status).toBe(200);
    expect(management.status).toBe(403);
    await expect(management.json()).resolves.toEqual({ error: 'missing_scope:machine-models' });
    const capacity = await httpFetch(`${baseUrl}/v1/remote/manage/native-capacity`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'status', id: '00000000-0000-4000-8000-000000000001' }),
    });
    expect(capacity.status).toBe(403);
  });

  it('coordinates isolated local engines with inference-only resource claims', async () => {
    const id = '00000000-0000-4000-8000-000000000002';
    const command = {
      action: 'acquire',
      id,
      ownerPid: process.pid,
      label: 'test recognition',
      bytes: 256 * 1024 ** 2,
      gpuBytes: 256 * 1024 ** 2,
      exclusive: false,
    };
    const post = (body: unknown) =>
      machineFetch('/v1/remote/manage/native-capacity', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      const response = await post(command);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ state: 'granted' });
      // No executable paths or product state may enter this new surface.
      expect((await post({ ...command, command: '/tmp/arbitrary-program' })).status).toBe(422);
      expect((await post({ ...command, bytes: -1 })).status).toBe(422);
    } finally {
      await post({ action: 'release', id });
    }
  });

  it('does not mount product data, terminals, grants, or the UI', async () => {
    for (const path of [
      '/api/projects',
      '/api/terminals',
      '/api/credentials',
      '/v1/apps/register',
      '/',
    ]) {
      const response = await machineFetch(path, {
        ...(path === '/v1/apps/register' ? { method: 'POST' } : {}),
      });
      expect([403, 404], `${path} unexpectedly reachable`).toContain(response.status);
    }
  });

  it('keeps project-persisting multimodal execution off the management surface', async () => {
    for (const path of [
      '/v1/remote/manage/image-gen/generate',
      '/v1/remote/manage/video-gen/generate',
      '/v1/remote/manage/audio/transcribe',
      '/v1/remote/manage/audio/synthesize',
      '/v1/remote/manage/audio/synthesize-stream',
    ]) {
      expect((await machineFetch(path, { method: 'POST' })).status).toBe(404);
    }
  });

  it('does not bootstrap the machine home as a user product store', async () => {
    for (const scope of ['projects', 'gezels', 'documents']) {
      await expect(access(join(home, scope))).rejects.toBeDefined();
    }
  });

  it('hints third-party OpenAI clients toward product-daemon discovery', async () => {
    // The broker holds canonical port 6228 on machine installs, so a client
    // configured with the once-stable base URL lands here. Still 404 — the
    // endpoint genuinely is not here — but with the one envelope OpenAI SDKs
    // surface verbatim, explaining where the product /v1 actually lives.
    const post = await httpFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    expect(post.status).toBe(404);
    const body = (await post.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('gezel_machine_engine_not_product_api');
    expect(body.error.message).toContain('runtime/port');

    const responses = await httpFetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', input: 'hi' }),
    });
    expect(responses.status).toBe(404);
    await expect(responses.json()).resolves.toMatchObject({
      error: { code: 'gezel_machine_engine_not_product_api' },
    });

    // The hint does not vary with auth.
    const authed = await machineFetch('/v1/models');
    expect(authed.status).toBe(404);
    await expect(authed.json()).resolves.toMatchObject({
      error: { code: 'gezel_machine_engine_not_product_api' },
    });

    const ollama = await httpFetch(`${baseUrl}/ollama/v1/models`);
    expect(ollama.status).toBe(404);
    await expect(ollama.json()).resolves.toMatchObject({
      error: { code: 'gezel_machine_engine_not_product_api' },
    });

    // Non-GET wrong paths get JSON from the catch-all too (Hono's default
    // would be plain text), naming whom the caller reached.
    const wrongPost = await httpFetch(`${baseUrl}/nonexistent`, { method: 'POST' });
    expect(wrongPost.status).toBe(404);
    await expect(wrongPost.json()).resolves.toMatchObject({
      error: 'not_found',
      service: 'gezel-machine-engine',
    });
  });
});
