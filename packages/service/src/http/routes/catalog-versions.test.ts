import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let baseUrl: string;
let token: string;
let home: string;
let httpFetch: typeof fetch;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-catalog-versions-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  token = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

function api(method: string, path: string, body?: unknown) {
  return httpFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('GET /api/catalog/:kind/:id/versions', () => {
  it('lists versions for a bundled gezel template', async () => {
    const res = await api('GET', '/api/catalog/gezel-template/meester/versions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      versions: Array<{ version: string; releasedAt: string; yanked: boolean }>;
    };
    expect(body.versions.length).toBeGreaterThan(0);
    expect(body.versions[0]?.yanked).toBe(false);
  });

  it('lists versions for a bundled toolset', async () => {
    const res = await api('GET', '/api/catalog/toolset/github/versions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { versions: Array<{ version: string }> };
    expect(body.versions.map((v) => v.version)).toContain('0.1.0');
  });

  it('returns an empty list for an unknown item', async () => {
    const res = await api('GET', '/api/catalog/toolset/does-not-exist/versions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { versions: unknown[] };
    expect(body.versions).toEqual([]);
  });
});

describe('GET /api/catalog/:kind/:id?version=', () => {
  it('returns the same manifest version that listVersions reported', async () => {
    const versionsRes = await api('GET', '/api/catalog/gezel-template/meester/versions');
    const { versions } = (await versionsRes.json()) as {
      versions: Array<{ version: string }>;
    };
    const target = versions[0]?.version;
    expect(target).toBeTruthy();

    const detailRes = await api('GET', `/api/catalog/gezel-template/meester?version=${target}`);
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      manifest: { version: string; kind: string };
    };
    expect(detail.manifest.kind).toBe('gezel-template');
    expect(detail.manifest.version).toBe(target);
  });

  it('returns 404 when an unknown version is requested', async () => {
    const res = await api('GET', '/api/catalog/gezel-template/meester?version=99.99.99');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/catalog/gezel-template/:id/install', () => {
  it('stamps templateId + templateVersion on the created gezel', async () => {
    const res = await api('POST', '/api/catalog/gezel-template/voorman/install', {
      name: 'Test Voorman',
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      id: string;
      templateId?: string;
      templateVersion?: string;
    };
    expect(created.templateId).toBe('voorman');
    expect(created.templateVersion).toBeTruthy();

    // Re-read to confirm the version was persisted in frontmatter, not
    // just echoed in the response.
    const re = await api('GET', `/api/gezels/${encodeURIComponent(created.id)}`);
    const detail = (await re.json()) as { templateId?: string; templateVersion?: string };
    expect(detail.templateId).toBe('voorman');
    expect(detail.templateVersion).toBe(created.templateVersion);
  });

  it('rejects with 404 when an explicit version is unknown', async () => {
    const res = await api('POST', '/api/catalog/gezel-template/meester/install', {
      name: 'Bad Pin',
      version: '99.99.99',
    });
    expect(res.status).toBe(404);
  });
});
