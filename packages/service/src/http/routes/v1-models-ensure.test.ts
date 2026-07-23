import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let baseUrl: string;
let rootToken: string;
let home: string;
let httpFetch: typeof fetch;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-v1-ensure-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  rootToken = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

function v1(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string } = {},
): Promise<Response> {
  return httpFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

describe('POST /v1/models/ensure — validation', () => {
  it('requires bearer auth', async () => {
    const res = await v1('POST', '/v1/models/ensure', {
      body: { model: 'llama-cpp:nonexistent' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 ambiguous_model for a bare id (no backend prefix)', async () => {
    const res = await v1('POST', '/v1/models/ensure', {
      body: { model: 'qwen3-4b-instruct' },
      token: rootToken,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('ambiguous_model');
  });

  it('returns 404 unknown_model when the catalog has no such id', async () => {
    const res = await v1('POST', '/v1/models/ensure', {
      body: { model: 'llama-cpp:definitely-not-a-real-model-id-xyzzy' },
      token: rootToken,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unknown_model');
  });

  it('returns 400 ambiguous_model for an ollama prefix (not yet wired)', async () => {
    const res = await v1('POST', '/v1/models/ensure', {
      body: { model: 'ollama:llama3.1' },
      token: rootToken,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('ambiguous_model');
  });

  it('rejects malformed bodies with a 422-ish Zod error', async () => {
    const res = await v1('POST', '/v1/models/ensure', {
      body: {},
      token: rootToken,
    });
    // The service's global Zod handler maps schema failures to 422.
    expect(res.status).toBe(422);
  });
});

describe('GET /v1/models/ensure/:jobId', () => {
  it('returns 404 for an unknown jobId', async () => {
    const res = await v1('GET', '/v1/models/ensure/00000000-0000-0000-0000-000000000000', {
      token: rootToken,
    });
    expect(res.status).toBe(404);
  });
});
