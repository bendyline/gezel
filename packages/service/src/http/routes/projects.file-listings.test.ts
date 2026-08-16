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

describe('listings with hidden=1', () => {
  it('workspace hides dotfiles and node_modules by default and shows them on request', async () => {
    const workspaceDir = await svc.context.store.projectWorkspaceDir(projectId);
    await writeFile(join(workspaceDir, '.env'), 'SECRET=1');
    await mkdir(join(workspaceDir, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(workspaceDir, 'node_modules', 'pkg', 'index.js'), '');

    const plain = await client.listProjectWorkspace(projectId, '', true);
    expect(plain.files.map((f) => f.path)).not.toContain('.env');
    expect(plain.files.map((f) => f.path)).not.toContain('node_modules');

    const hidden = await client.listProjectWorkspace(projectId, '', true, { hidden: true });
    const paths = hidden.files.map((f) => f.path);
    expect(paths).toContain('.env');
    expect(paths).toContain('node_modules');
    expect(paths).toContain('sub/note.md');
    expect(paths.some((p) => p.startsWith('node_modules/'))).toBe(false);
  });

  it('artifacts hides the reserved shadow cache by default and shows it on request', async () => {
    const artifactsDir = svc.context.store.projectArtifactsDir(projectId);
    await mkdir(join(artifactsDir, 'shadow', 'reports'), { recursive: true });
    await writeFile(join(artifactsDir, 'shadow', 'reports', 'summary.md'), 'shadow twin');

    const plain = await client.listProjectArtifacts(projectId, '', true);
    expect(plain.files.map((f) => f.path).some((p) => p.startsWith('shadow'))).toBe(false);

    const hidden = await client.listProjectArtifacts(projectId, '', true, { hidden: true });
    const paths = hidden.files.map((f) => f.path);
    expect(paths).toContain('shadow');
    expect(paths).toContain('shadow/reports/summary.md');
    expect(paths).toContain('reports/summary.md');
  });

  it('shallow artifact listings follow the same rule', async () => {
    const plain = await client.listProjectArtifacts(projectId);
    expect(plain.files.map((f) => f.name)).not.toContain('shadow');

    const hidden = await client.listProjectArtifacts(projectId, '', false, { hidden: true });
    expect(hidden.files.map((f) => f.name)).toContain('shadow');
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
