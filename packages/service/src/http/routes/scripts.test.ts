import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GetScriptSourceResponse, SaveScriptSourceResponse } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let baseUrl: string;
let token: string;
let home: string;
let httpFetch: typeof fetch;
let projectId: string;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-scripts-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  token = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;

  const res = await api('POST', '/api/projects', {
    name: 'Script Editor Test',
    about:
      'Project used by the scripts-route tests to host editable scripts. It exists only inside the temp home this suite creates.',
    missionObjectives:
      'Exercise the script source endpoints end to end: create, read, save, conflict, delete.',
  });
  expect(res.status).toBe(201);
  projectId = ((await res.json()) as { id: string }).id;
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

function api(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  return httpFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(headers ?? {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('script source endpoints', () => {
  it('POST creates a script from a template; second POST is a 409', async () => {
    const res = await api('POST', `/api/projects/${projectId}/scripts`, {
      name: 'hello-script',
      description: 'Says hello to whoever runs it.',
      template: 'blank',
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { name: string; source: string; hash: string };
    expect(created.source).toContain('defineScript');
    expect(created.source).toContain("name: 'hello-script'");

    const dupe = await api('POST', `/api/projects/${projectId}/scripts`, {
      name: 'hello-script',
    });
    expect(dupe.status).toBe(409);
  });

  it('GET source round-trips, with hash + parsed meta', async () => {
    const res = await api('GET', `/api/projects/${projectId}/scripts/source?name=hello-script`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetScriptSourceResponse;
    expect(body.name).toBe('hello-script');
    expect(body.source).toContain('defineScript');
    expect(body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.meta?.name).toBe('hello-script');
  });

  it('PUT with the right baseHash saves and lands on disk; stale hash conflicts', async () => {
    const get = (await (
      await api('GET', `/api/projects/${projectId}/scripts/source?name=hello-script`)
    ).json()) as GetScriptSourceResponse;

    const edited = get.source.replace('Says hello', 'Waves politely');
    const saveRes = await api('PUT', `/api/projects/${projectId}/scripts/source`, {
      name: 'hello-script',
      source: edited,
      baseHash: get.hash,
    });
    expect(saveRes.status).toBe(200);
    const saved = (await saveRes.json()) as SaveScriptSourceResponse;
    expect(saved.status).toBe('saved');
    if (saved.status !== 'saved') return;
    expect(saved.metaOk).toBe(true);
    expect(saved.diagnostics).toEqual([]);

    const onDisk = await readFile(
      join(home, 'projects', projectId, 'scripts', 'hello-script.ts'),
      'utf8',
    );
    expect(onDisk).toContain('Waves politely');

    // Same baseHash again is now stale → structured conflict, file untouched.
    const conflictRes = await api('PUT', `/api/projects/${projectId}/scripts/source`, {
      name: 'hello-script',
      source: 'totally different',
      baseHash: get.hash,
    });
    const conflict = (await conflictRes.json()) as SaveScriptSourceResponse;
    expect(conflict.status).toBe('conflict');
    if (conflict.status !== 'conflict') return;
    expect(conflict.currentHash).toBe(saved.hash);
    expect(conflict.currentSource).toContain('Waves politely');
  });

  it('PUT persists broken-meta scripts (metaOk: false) and GET still serves them', async () => {
    const res = await api('PUT', `/api/projects/${projectId}/scripts/source`, {
      name: 'broken-meta',
      source: 'const x = 1;\n',
    });
    const saved = (await res.json()) as SaveScriptSourceResponse;
    expect(saved.status).toBe('saved');
    if (saved.status !== 'saved') return;
    expect(saved.metaOk).toBe(false);
    expect(saved.diagnostics.some((d) => d.source === 'meta')).toBe(true);

    // Hidden from the list…
    const list = (await (await api('GET', `/api/projects/${projectId}/scripts`)).json()) as {
      scripts: Array<{ name: string }>;
    };
    expect(list.scripts.some((s) => s.name === 'broken-meta')).toBe(false);

    // …but the editor can still load it.
    const get = await api('GET', `/api/projects/${projectId}/scripts/source?name=broken-meta`);
    expect(get.status).toBe(200);
    const body = (await get.json()) as GetScriptSourceResponse;
    expect(body.metaError).toBeTruthy();
  });

  it('PUT reports runtime-compat diagnostics for non-erasable syntax', async () => {
    const get = (await (
      await api('GET', `/api/projects/${projectId}/scripts/source?name=hello-script`)
    ).json()) as GetScriptSourceResponse;
    const res = await api('PUT', `/api/projects/${projectId}/scripts/source`, {
      name: 'hello-script',
      source: `${get.source}\nenum Mode { A, B }\n`,
      baseHash: get.hash,
    });
    const saved = (await res.json()) as SaveScriptSourceResponse;
    expect(saved.status).toBe('saved');
    if (saved.status !== 'saved') return;
    expect(saved.metaOk).toBe(true);
    expect(saved.diagnostics.some((d) => d.source === 'runtime-compat')).toBe(true);
  });

  it('rejects path-traversal names with a validation error', async () => {
    const get = await api('GET', `/api/projects/${projectId}/scripts/source?name=../escape`);
    expect(get.status).toBe(422);
    const put = await api('PUT', `/api/projects/${projectId}/scripts/source`, {
      name: 'a/b',
      source: 'x',
    });
    expect(put.status).toBe(422);
  });

  it('DELETE removes the script; a second DELETE is a 404', async () => {
    const res = await api('DELETE', `/api/projects/${projectId}/scripts/source?name=broken-meta`);
    expect(res.status).toBe(200);
    const gone = await api('DELETE', `/api/projects/${projectId}/scripts/source?name=broken-meta`);
    expect(gone.status).toBe(404);
  });
});

describe('GET /api/sdk/types', () => {
  it('serves the SDK typings with a stable content-hash ETag', async () => {
    const res = await api('GET', '/api/sdk/types');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string; files: Array<{ content: string }> };
    expect(body.files.length).toBeGreaterThan(0);
    const all = body.files.map((f) => f.content).join('\n');
    expect(all).toContain('GezelSDK');
    expect(all).toContain('defineScript');
    expect(res.headers.get('etag')).toBe(body.version);

    const revalidate = await api('GET', '/api/sdk/types', undefined, {
      'If-None-Match': body.version,
    });
    expect(revalidate.status).toBe(304);
  });
});
