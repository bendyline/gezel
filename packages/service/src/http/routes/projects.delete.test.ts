import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GezelClient } from '@bendyline/gezel-client';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let client: GezelClient;
let home: string;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-delete-route-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  const baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  const httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  client = new GezelClient({ baseUrl, token: svc.context.token, fetch: httpFetch });
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

describe('DELETE /api/projects/:id', () => {
  it('safe-deletes a project and drops it from the listing while keeping files', async () => {
    const created = await client.createProject({ name: 'Doomed' });
    await svc.context.store.writeProjectArtifact(created.id, 'out.txt', 'result');

    const res = await client.deleteProject(created.id);
    expect(res).toMatchObject({ ok: true, removedWorkspace: false, workspaceSource: 'internal' });

    const list = await client.listProjects();
    expect(list.projects.some((p) => p.id === created.id)).toBe(false);
    expect(existsSync(join(home, 'projects', created.id, 'artifacts', 'out.txt'))).toBe(true);
  });

  it('removes workspace + artifacts when removeWorkspace is set', async () => {
    const created = await client.createProject({ name: 'DoomedHard' });
    const ws = await svc.context.store.projectWorkspaceDir(created.id);
    await svc.context.store.writeProjectArtifact(created.id, 'out.txt', 'result');

    const res = await client.deleteProject(created.id, { removeWorkspace: true });
    expect(res.removedWorkspace).toBe(true);
    expect(await client.getProject(created.id).catch(() => null)).toBeNull();
    // The user's files are gone (a background service may leave an empty
    // project dir behind, but never the workspace/artifact contents).
    expect(existsSync(join(ws, 'package.json'))).toBe(false);
    expect(existsSync(join(home, 'projects', created.id, 'artifacts', 'out.txt'))).toBe(false);
  });

  it('refuses to delete the default project (400)', async () => {
    await svc.context.store.ensureDefaultProject();
    await expect(client.deleteProject('default')).rejects.toThrow();
    expect(await client.getProject('default')).toBeTruthy();
  });

  it('404s for an unknown project', async () => {
    await expect(client.deleteProject('does-not-exist')).rejects.toThrow();
  });
});
