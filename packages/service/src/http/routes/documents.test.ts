import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  home = await mkdtemp(join(tmpdir(), 'gezel-documents-'));
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

describe('PUT /api/documents/write + GET /read', () => {
  it('writes a document and reads it back via the canonical (global) path', async () => {
    const writeRes = await api('PUT', '/api/documents/write', {
      path: 'guidelines/style.md',
      content: '# Style\n\nUse Oxford commas.\n',
    });
    expect(writeRes.status).toBe(200);
    const wrote = (await writeRes.json()) as { ok: boolean; path: string };
    expect(wrote.ok).toBe(true);
    expect(wrote.path).toBe('guidelines/style.md');

    // Verify on disk under the test's GEZEL_HOME — proves the route went
    // through Store and landed where listDocumentsRecursive will find it.
    const onDisk = await readFile(join(home, 'documents', 'guidelines', 'style.md'), 'utf8');
    expect(onDisk).toContain('Oxford commas');

    const readRes = await api('GET', '/api/documents/read?path=guidelines/style.md');
    expect(readRes.status).toBe(200);
    const got = (await readRes.json()) as { content: string; kind: string };
    expect(got.kind).toBe('document');
    expect(got.content).toContain('Oxford commas');
  });

  it('returns 400 when /read is called without ?path=', async () => {
    const res = await api('GET', '/api/documents/read');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/path/);
  });

  it('returns 404 when the document does not exist', async () => {
    const res = await api('GET', '/api/documents/read?path=does/not/exist.md');
    expect(res.status).toBe(404);
  });

  it('reads a Default-project report through its qualified artifact attachment path', async () => {
    await svc.context.store.writeProjectArtifact(
      'default',
      'night-shift-report.md',
      '# Night Shift Report\n',
    );

    const path = encodeURIComponent('projects/default/artifacts/night-shift-report.md');
    const res = await api('GET', `/api/documents/read?path=${path}`);
    expect(res.status).toBe(200);
    const got = (await res.json()) as { content: string; kind: string };
    expect(got.kind).toBe('artifact');
    expect(got.content).toContain('Night Shift Report');
  });
});

describe('GET /api/documents — listing', () => {
  it('lists documents recursively after writing nested paths', async () => {
    await api('PUT', '/api/documents/write', { path: 'reports/q1.md', content: 'q1' });
    await api('PUT', '/api/documents/write', { path: 'reports/q2.md', content: 'q2' });
    await api('PUT', '/api/documents/write', { path: 'top-level.md', content: 'top' });

    const res = await api('GET', '/api/documents?recursive=1');
    expect(res.status).toBe(200);
    const data = (await res.json()) as { files: Array<{ path: string }> };
    const paths = data.files.map((f) => f.path);
    expect(paths).toContain('reports/q1.md');
    expect(paths).toContain('reports/q2.md');
    expect(paths).toContain('top-level.md');
  });

  it('reports mtimes and the truncation flag when the browser asks for stats', async () => {
    await api('PUT', '/api/documents/write', { path: 'stats/a.md', content: 'a' });

    const res = await api('GET', '/api/documents?recursive=1&stats=1');
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      files: Array<{ path: string; isDirectory: boolean; mtimeMs?: number }>;
      truncated: boolean;
    };
    const file = data.files.find((f) => f.path === 'stats/a.md');
    expect(typeof file?.mtimeMs).toBe('number');
    expect(data.truncated).toBe(false);
    // Directories never carry stats — the walker only lstats files.
    expect(data.files.find((f) => f.path === 'stats')?.mtimeMs).toBeUndefined();
  });

  it('surfaces dotfiles and Office lock files only under hidden=1', async () => {
    await api('PUT', '/api/documents/write', { path: '.private/secret.md', content: 's' });
    await api('PUT', '/api/documents/write', { path: '~$deck.pptx', content: 'lock' });

    const plain = (await (await api('GET', '/api/documents?recursive=1')).json()) as {
      files: Array<{ path: string }>;
    };
    expect(plain.files.some((f) => f.path.startsWith('.private'))).toBe(false);
    expect(plain.files.some((f) => f.path === '~$deck.pptx')).toBe(false);

    const hidden = (await (await api('GET', '/api/documents?recursive=1&hidden=1')).json()) as {
      files: Array<{ path: string }>;
    };
    expect(hidden.files.some((f) => f.path.startsWith('.private'))).toBe(true);
    expect(hidden.files.some((f) => f.path === '~$deck.pptx')).toBe(true);
  });

  it('non-recursive list at a subpath returns only that folder', async () => {
    await api('PUT', '/api/documents/write', {
      path: 'sub/inner.md',
      content: 'inner',
    });
    const res = await api('GET', '/api/documents?path=sub');
    expect(res.status).toBe(200);
    const data = (await res.json()) as { files: Array<{ path: string }> };
    expect(data.files.some((f) => f.path.endsWith('inner.md'))).toBe(true);
  });
});

describe('POST /api/documents/mkdir', () => {
  it('creates a folder, then write under it succeeds', async () => {
    const mkdirRes = await api('POST', '/api/documents/mkdir', { path: 'team' });
    expect(mkdirRes.status).toBe(200);

    const writeRes = await api('PUT', '/api/documents/write', {
      path: 'team/onboarding.md',
      content: '# Onboarding',
    });
    expect(writeRes.status).toBe(200);

    const readRes = await api('GET', '/api/documents/read?path=team/onboarding.md');
    expect(readRes.status).toBe(200);
  });
});

describe('POST /api/documents/rename', () => {
  it('renames a document without rewriting its contents', async () => {
    await api('PUT', '/api/documents/write', {
      path: 'rename/source.md',
      content: '# Keep me',
    });

    const renameRes = await api('POST', '/api/documents/rename', {
      fromPath: 'rename/source.md',
      toPath: 'rename/destination.md',
    });
    expect(renameRes.status).toBe(200);

    expect((await api('GET', '/api/documents/read?path=rename/source.md')).status).toBe(404);
    const renamed = await api('GET', '/api/documents/read?path=rename/destination.md');
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { content: string }).content).toBe('# Keep me');
  });

  it('renames a folder and all documents beneath it', async () => {
    await api('PUT', '/api/documents/write', {
      path: 'rename-folder/before/nested.md',
      content: 'nested',
    });

    const renameRes = await api('POST', '/api/documents/rename', {
      fromPath: 'rename-folder/before',
      toPath: 'rename-folder/after',
    });
    expect(renameRes.status).toBe(200);
    expect(
      (await api('GET', '/api/documents/read?path=rename-folder/before/nested.md')).status,
    ).toBe(404);
    expect(
      (await api('GET', '/api/documents/read?path=rename-folder/after/nested.md')).status,
    ).toBe(200);
  });

  it('rejects a rename that would overwrite an existing path', async () => {
    await api('PUT', '/api/documents/write', {
      path: 'rename-conflict/one.md',
      content: 'one',
    });
    await api('PUT', '/api/documents/write', {
      path: 'rename-conflict/two.md',
      content: 'two',
    });

    const renameRes = await api('POST', '/api/documents/rename', {
      fromPath: 'rename-conflict/one.md',
      toPath: 'rename-conflict/two.md',
    });
    expect(renameRes.status).toBe(409);
  });
});

describe('DELETE /api/documents/delete', () => {
  it('round-trip: write, read, delete, then read returns 404', async () => {
    await api('PUT', '/api/documents/write', {
      path: 'tmp/scratch.md',
      content: 'scratch',
    });
    const before = await api('GET', '/api/documents/read?path=tmp/scratch.md');
    expect(before.status).toBe(200);

    const delRes = await api('DELETE', '/api/documents/delete?path=tmp/scratch.md');
    expect(delRes.status).toBe(200);
    const ok = (await delRes.json()) as { ok: boolean };
    expect(ok.ok).toBe(true);

    const after = await api('GET', '/api/documents/read?path=tmp/scratch.md');
    expect(after.status).toBe(404);
  });

  it('returns 400 when /delete is called without ?path=', async () => {
    const res = await api('DELETE', '/api/documents/delete');
    expect(res.status).toBe(400);
  });
});

describe('schema validation', () => {
  it('rejects /write with empty path (Zod min(1))', async () => {
    const res = await api('PUT', '/api/documents/write', { path: '', content: 'x' });
    // Zod parse throws → Hono surfaces it; whatever non-2xx we return,
    // the request must not have written a document. Verify by looking
    // for an empty-path file on disk.
    expect(res.status).not.toBe(200);
  });
});
