import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';
import { resolveRecommendedImageSteps } from './image-gen.js';

let svc: RunningService;
let baseUrl: string;
let token: string;
let home: string;
let httpFetch: typeof fetch;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

// 30s hook timeouts — startService boot races contention from the
// other integration files when they all run in the same `pnpm test`
// invocation; the 10s default trips occasionally.
beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-image-gen-'));
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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('POST /api/image-gen/generate', () => {
  it('returns an artifact path and writes a real PNG to disk', async () => {
    const res = await api('POST', '/api/image-gen/generate', {
      prompt: 'a tiny compass',
      width: 8,
      height: 8,
      seed: 1234,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      artifactPath: string;
      workspacePath: string | null;
      meta: { model: string; seed: number; widthPx: number; heightPx: number };
    };
    expect(body.artifactPath.startsWith('generated/')).toBe(true);
    expect(body.artifactPath.endsWith('.png')).toBe(true);
    expect(body.meta.seed).toBe(1234);
    expect(body.meta.widthPx).toBe(8);
    expect(body.meta.heightPx).toBe(8);

    const fileOnDisk = join(home, 'projects', 'default', 'artifacts', body.artifactPath);
    const bytes = await readFile(fileOnDisk);
    expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });

  it('also drops a workspace copy at assets/generated/ for HTML embedding', async () => {
    const res = await api('POST', '/api/image-gen/generate', {
      prompt: 'a workspace-bound logo',
      width: 8,
      height: 8,
      seed: 5678,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      artifactPath: string;
      workspacePath: string | null;
    };
    // The default project allows workspace writes, so the route should
    // have produced both copies.
    expect(body.workspacePath).not.toBeNull();
    // Short, seed-keyed filename — small models can copy this verbatim
    // into <img src=...> without inventing a clean alias.
    expect(body.workspacePath).toBe('assets/generated/image-5678.png');

    const onDisk = join(home, 'projects', 'default', 'workspace', body.workspacePath ?? '');
    const bytes = await readFile(onDisk);
    expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);

    // Both copies should be byte-identical — workspace is a duplicate,
    // not a re-encode.
    const artifactBytes = await readFile(
      join(home, 'projects', 'default', 'artifacts', body.artifactPath),
    );
    expect(bytes.equals(artifactBytes)).toBe(true);
  });

  it('rejects an empty prompt with 400', async () => {
    const res = await api('POST', '/api/image-gen/generate', { prompt: '' });
    expect(res.status).toBe(400);
  });

  it('honors `saveAs` for the workspace copy (artifact path stays seed-keyed)', async () => {
    const res = await api('POST', '/api/image-gen/generate', {
      prompt: 'a pinned-name logo',
      width: 8,
      height: 8,
      seed: 9999,
      saveAs: 'logo.png',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifactPath: string; workspacePath: string | null };
    expect(body.workspacePath).toBe('logo.png');
    expect(body.artifactPath).toMatch(/^generated\/.*-9999\.png$/);

    const onDisk = join(home, 'projects', 'default', 'workspace', 'logo.png');
    const bytes = await readFile(onDisk);
    expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });

  it('rejects `saveAs` paths with traversal segments or missing extension', async () => {
    for (const bad of ['../escape.png', '/abs.png', 'no-ext', 'sub/./logo.png']) {
      const res = await api('POST', '/api/image-gen/generate', {
        prompt: 'x',
        width: 8,
        height: 8,
        saveAs: bad,
      });
      expect(res.status, `expected 400 for saveAs=${bad}`).toBe(400);
    }
  });
});

describe('GET /api/image-gen/models', () => {
  it('returns an empty list on a fresh install', async () => {
    const res = await api('GET', '/api/image-gen/models');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: unknown[] };
    expect(Array.isArray(body.models)).toBe(true);
  });
});

describe('DELETE /api/image-gen/models/:id', () => {
  it("is idempotent when the model isn't installed", async () => {
    const res = await api('DELETE', '/api/image-gen/models/never-installed');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

describe('resolveRecommendedImageSteps', () => {
  it('uses the first installed image model when the request omits model', async () => {
    const steps = await resolveRecommendedImageSteps(
      {
        catalog: {
          get: async (kind: string, id: string) => ({
            kind,
            id,
            manifest: { kind: 'image-model', id, recommendedSteps: 4 },
          }),
        },
      } as never,
      {
        listInstalledModels: async () => [
          {
            id: 'sdxl-lightning-4step',
            name: 'SDXL Lightning',
            approxSizeBytes: 1,
            installedAt: new Date().toISOString(),
          },
        ],
      },
      undefined,
    );

    expect(steps).toBe(4);
  });

  it('uses the explicitly requested model without listing installed models', async () => {
    const steps = await resolveRecommendedImageSteps(
      {
        catalog: {
          get: async (_kind: string, id: string) => ({
            manifest: { kind: 'image-model', id, recommendedSteps: 30 },
          }),
        },
      } as never,
      {
        listInstalledModels: async () => {
          throw new Error('should not list models');
        },
      },
      'sdxl-base-1.0',
    );

    expect(steps).toBe(30);
  });
});

describe('POST /api/image-gen/models/:id/pull', () => {
  it('returns 404 for an unknown catalog id', async () => {
    const res = await api('POST', '/api/image-gen/models/does-not-exist/pull');
    expect(res.status).toBe(404);
  });
});
