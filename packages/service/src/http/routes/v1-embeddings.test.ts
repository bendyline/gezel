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
  home = await mkdtemp(join(tmpdir(), 'gezel-v1-embed-'));
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

describe('POST /v1/embeddings', () => {
  it('rejects requests without auth', async () => {
    const res = await v1('POST', '/v1/embeddings', {
      body: { model: 'copilot:mock-embedding', input: 'hello' },
    });
    expect(res.status).toBe(401);
  });

  it('returns an OpenAI-shaped envelope with one vector per input', async () => {
    const res = await v1('POST', '/v1/embeddings', {
      body: {
        model: 'copilot:mock-embedding',
        input: ['hello', 'world'],
      },
      token: rootToken,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      model: string;
      data: Array<{ object: string; index: number; embedding: number[] }>;
      usage: { prompt_tokens: number; total_tokens: number };
    };
    expect(body.object).toBe('list');
    expect(body.model).toBe('copilot:mock-embedding');
    expect(body.data).toHaveLength(2);
    expect(body.data[0]?.index).toBe(0);
    expect(body.data[1]?.index).toBe(1);
    expect(body.data[0]?.embedding).toHaveLength(8);
    // Mock embedding is deterministic — the same input twice yields the
    // same vector. Different inputs yield different vectors.
    expect(body.data[0]?.embedding).not.toEqual(body.data[1]?.embedding);
    expect(body.usage.prompt_tokens).toBe('hello'.length + 'world'.length);
  });

  it('accepts a single string input (not array)', async () => {
    const res = await v1('POST', '/v1/embeddings', {
      body: { model: 'copilot:mock-embedding', input: 'one' },
      token: rootToken,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ embedding: number[] }> };
    expect(body.data).toHaveLength(1);
  });

  it('returns 404 model_not_found for an unknown provider prefix', async () => {
    const res = await v1('POST', '/v1/embeddings', {
      body: { model: 'unknownprovider:foo', input: 'x' },
      token: rootToken,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('model_not_found');
  });

  it('returns 400 encoding_format_not_supported for base64', async () => {
    const res = await v1('POST', '/v1/embeddings', {
      body: {
        model: 'copilot:mock-embedding',
        input: 'x',
        encoding_format: 'base64',
      },
      token: rootToken,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('encoding_format_not_supported');
  });

  it('returns 400 invalid_body (OpenAI envelope, not the internal 422) on a schema mismatch', async () => {
    const res = await v1('POST', '/v1/embeddings', {
      body: { model: 'copilot:mock-embedding' },
      token: rootToken,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; type: string; message: string } };
    expect(body.error.code).toBe('invalid_body');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('input');
  });

  it('returns 400 invalid_json (not 500) when the body is not JSON at all', async () => {
    const res = await httpFetch(`${baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${rootToken}`,
      },
      body: '{"model": "copilot:mock-embedding", "input": [',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; type: string } };
    expect(body.error.code).toBe('invalid_json');
    expect(body.error.type).toBe('invalid_request_error');
  });
});
