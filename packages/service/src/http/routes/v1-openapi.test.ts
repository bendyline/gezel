import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let baseUrl: string;
let home: string;
let httpFetch: typeof fetch;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-v1-openapi-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

describe('GET /v1/openapi.json', () => {
  it('is served unauthenticated and returns a valid OpenAPI 3.1 document', async () => {
    const res = await httpFetch(`${baseUrl}/v1/openapi.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      openapi: string;
      info: { title: string; version: string };
      paths: Record<string, unknown>;
      components: { securitySchemes: Record<string, unknown> };
    };
    expect(body.openapi).toBe('3.1.0');
    expect(body.info.title).toBe('Gezel Public API');
    expect(typeof body.info.version).toBe('string');
    expect(body.paths['/v1/chat/completions']).toBeTruthy();
    expect(body.paths['/v1/embeddings']).toBeTruthy();
    expect(body.paths['/v1/models']).toBeTruthy();
    expect(body.paths['/v1/models/ensure']).toBeTruthy();
    expect(body.paths['/v1/apps/register']).toBeTruthy();
    expect(body.components.securitySchemes.bearerAuth).toBeTruthy();
  });
});
