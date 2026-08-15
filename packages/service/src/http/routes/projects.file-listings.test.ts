import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GezelClient } from '@bendyline/gezel-client';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let client: GezelClient;
let home: string;
let projectId: string;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-file-listings-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  const baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  const httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  client = new GezelClient({ baseUrl, token: svc.context.token, fetch: httpFetch });

  const project = await client.createProject({ name: 'Listing Stats' });
  projectId = project.id;

  const workspaceDir = await svc.context.store.projectWorkspaceDir(projectId);
  await mkdir(join(workspaceDir, 'sub'), { recursive: true });
  await writeFile(join(workspaceDir, 'sub', 'note.md'), 'note');
  await svc.context.store.writeProjectArtifact(projectId, 'reports/summary.md', 'summary');
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

describe('recursive listings with stats=1', () => {
  it('workspace returns mtimeMs on files and never on directories', async () => {
    const res = await client.listProjectWorkspace(projectId, '', true, { stats: true });
    const byPath = new Map(res.files.map((f) => [f.path, f]));
    expect(byPath.get('sub/note.md')?.mtimeMs).toBeTypeOf('number');
    expect(byPath.get('sub')?.mtimeMs).toBeUndefined();
  });

  it('workspace omits mtimeMs without the stats flag', async () => {
    const res = await client.listProjectWorkspace(projectId, '', true);
    expect(res.files.length).toBeGreaterThan(0);
    expect(res.files.every((f) => f.mtimeMs === undefined)).toBe(true);
  });

  it('artifacts returns mtimeMs on files and never on directories', async () => {
    const res = await client.listProjectArtifacts(projectId, '', true, { stats: true });
    const byPath = new Map(res.files.map((f) => [f.path, f]));
    expect(byPath.get('reports/summary.md')?.mtimeMs).toBeTypeOf('number');
    expect(byPath.get('reports')?.mtimeMs).toBeUndefined();
  });

  it('artifacts omits mtimeMs without the stats flag', async () => {
    const res = await client.listProjectArtifacts(projectId, '', true);
    expect(res.files.every((f) => f.mtimeMs === undefined)).toBe(true);
  });
});

describe('GET /api/projects/:id/index/files?detail=1', () => {
  it('returns an empty list for a never-indexed project', async () => {
    const fresh = await client.createProject({ name: 'Never Indexed' });
    const res = await client.listProjectIndexFilesDetail(fresh.id);
    expect(res).toEqual({ files: [], total: 0 });
  });

  it('returns the flat file list with mtimes after a scan', async () => {
    await svc.context.workspaceIndex.refreshAndWait(projectId);
    const res = await client.listProjectIndexFilesDetail(projectId);
    expect(res.total).toBe(res.files.length);
    const note = res.files.find((f) => f.path === 'sub/note.md');
    expect(note?.mtimeMs).toBeTypeOf('number');
    expect(note?.size).toBeTypeOf('number');
  });

  it('keeps the prefix-autocomplete mode unchanged', async () => {
    const httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
    const res = await httpFetch(
      `${svc.cert ? 'https' : 'http'}://127.0.0.1:${svc.port}/api/projects/${projectId}/index/files?prefix=sub`,
      { headers: { authorization: `Bearer ${svc.context.token}` } },
    );
    const body = (await res.json()) as { paths?: string[] };
    expect(Array.isArray(body.paths)).toBe(true);
    expect(body.paths).toContain('sub/');
  });
});
