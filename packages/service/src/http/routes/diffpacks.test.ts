import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

/**
 * Full-service integration for the diffpack routes: real wiring (manager,
 * draft store, artifact store, workspace write gate) over real HTTP.
 *
 * The load-bearing case is the last describe block — applying to an external
 * folder the project has NOT granted gezels write access to. That is the
 * whole reason diffpacks exist, and it is the one behavior a unit test with a
 * stubbed store could pass while the shipped route 403s.
 */

let svc: RunningService;
let baseUrl: string;
let token: string;
let home: string;
let scratch: string;
let httpFetch: typeof fetch;
let projectId: string;
let externalDir: string;
let externalProjectId: string;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

// biome-ignore lint/suspicious/noExplicitAny: test-local JSON reader
async function json(res: Response): Promise<any> {
  return res.json();
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  return httpFetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}

/** Seed a workspace file in the internal-workspace fixture project. */
async function seed(rel: string, content: string): Promise<void> {
  const wd = await svc.context.store.projectWorkspaceDir(projectId);
  const full = join(wd, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content, 'utf8');
}

/** Draft + seal a pack straight through the manager (the craftbook's job). */
async function makePack(
  pid: string,
  packId: string,
  draft: () => Promise<void>,
  title = 'Fix the parser',
): Promise<void> {
  await svc.context.diffpacks.ensure(pid, packId, {
    title,
    origin: { kind: 'boekwachter-issue', issueRefs: ['BW-1'] },
    taskRef: `${pid}/${packId}`,
    gezelName: 'Rex',
  });
  await svc.context.store.writeProjectArtifact(
    pid,
    `diffpacks/${packId}/notes.md`,
    '# Fix\n\nThe parser dropped the trailing comma.\n',
  );
  await draft();
  await svc.context.diffpacks.seal(pid, packId);
}

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-diffpack-routes-'));
  scratch = await mkdtemp(join(tmpdir(), 'gezel-diffpack-scratch-'));
  svc = await startService({ home });
  baseUrl = `${svc.cert ? 'https' : 'http'}://127.0.0.1:${svc.port}`;
  token = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;

  projectId = (await svc.context.store.createProject({ name: 'internal' })).id;
  await mkdir(await svc.context.store.projectWorkspaceDir(projectId), { recursive: true });

  externalDir = join(scratch, 'checkout');
  await mkdir(externalDir, { recursive: true });
  await writeFile(join(externalDir, 'parser.ts'), 'const trailing = false;\n', 'utf8');
  externalProjectId = (
    await svc.context.store.createProject({ name: 'external', workingDir: externalDir })
  ).id;
}, 60_000);

afterAll(async () => {
  await svc?.stop().catch(() => {});
  await rm(home, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
});

describe('GET /api/projects/:id/diffpacks', () => {
  it('lists sealed packs with their notes and rolled-up counts', async () => {
    await seed('list/a.ts', 'a0\n');
    await makePack(projectId, '10', async () => {
      await svc.context.diffpacks.drafts.write(projectId, '10', 'list/a.ts', 'a1\n');
    });

    const list = await json(await api(`/api/projects/${projectId}/diffpacks`));
    const pack = list.diffpacks.find((p: { packId: string }) => p.packId === '10');
    expect(pack).toMatchObject({ status: 'ready', additions: 1, deletions: 1 });
    expect(pack.drifted).toEqual([]);
    expect(pack.overlaps).toEqual([]);

    const detail = await json(await api(`/api/projects/${projectId}/diffpacks/10`));
    expect(detail.notes).toContain('trailing comma');
    expect(detail.diffpack.summary).toBe('The parser dropped the trailing comma.');
  });

  it('404s an unknown pack', async () => {
    const res = await api(`/api/projects/${projectId}/diffpacks/9999`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/projects/:id/diffpacks/:packId/apply', () => {
  it('applies the whole pack and reports it applied', async () => {
    await seed('apply/a.ts', 'value = 0\n');
    await makePack(projectId, '11', async () => {
      await svc.context.diffpacks.drafts.write(projectId, '11', 'apply/a.ts', 'value = 1\n');
    });

    const res = await api(`/api/projects/${projectId}/diffpacks/11/apply`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.diffpack.status).toBe('applied');
    expect(await svc.context.store.readProjectWorkspaceFile(projectId, 'apply/a.ts')).toBe(
      'value = 1\n',
    );
  });

  it('applies only the named paths', async () => {
    await seed('subset/a.ts', 'a0\n');
    await seed('subset/b.ts', 'b0\n');
    await makePack(projectId, '12', async () => {
      await svc.context.diffpacks.drafts.write(projectId, '12', 'subset/a.ts', 'a1\n');
      await svc.context.diffpacks.drafts.write(projectId, '12', 'subset/b.ts', 'b1\n');
    });

    const body = await json(
      await api(`/api/projects/${projectId}/diffpacks/12/apply`, {
        method: 'POST',
        body: JSON.stringify({ paths: ['subset/a.ts'] }),
      }),
    );
    expect(body.diffpack.status).toBe('partially-applied');
    expect(await svc.context.store.readProjectWorkspaceFile(projectId, 'subset/b.ts')).toBe('b0\n');
  });

  it('409s with the drifted paths instead of a raw patch rejection', async () => {
    await seed('drift/a.ts', 'const a = 1;\n');
    await makePack(projectId, '13', async () => {
      await svc.context.diffpacks.drafts.write(projectId, '13', 'drift/a.ts', 'const a = 2;\n');
    });
    await seed('drift/a.ts', 'const a = 1; // edited by hand\n');

    const res = await api(`/api/projects/${projectId}/diffpacks/13/apply`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.code).toBe('drifted');
    expect(body.paths).toEqual(['drift/a.ts']);
  });
});

describe('POST /api/projects/:id/diffpacks/:packId/dismiss', () => {
  it('marks the pack dismissed and drops its draft tree', async () => {
    await seed('dismiss/a.ts', 'a0\n');
    await makePack(projectId, '14', async () => {
      await svc.context.diffpacks.drafts.write(projectId, '14', 'dismiss/a.ts', 'a1\n');
    });

    const body = await json(
      await api(`/api/projects/${projectId}/diffpacks/14/dismiss`, { method: 'POST' }),
    );
    expect(body.diffpack.status).toBe('dismissed');
    expect(await svc.context.store.readProjectWorkspaceFile(projectId, 'dismiss/a.ts')).toBe(
      'a0\n',
    );
  });
});

describe('GET /api/projects/:id/diffpacks/:packId/export', () => {
  it('streams a zip carrying the patches, notes and apply instructions', async () => {
    await seed('export/a.ts', 'a0\n');
    await makePack(projectId, '15', async () => {
      await svc.context.diffpacks.drafts.write(projectId, '15', 'export/a.ts', 'a1\n');
    });

    const res = await api(`/api/projects/${projectId}/diffpacks/15/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toContain('DP-15.zip');

    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    const text = bytes.toString('latin1');
    for (const entry of ['notes.md', 'manifest.json', 'APPLY.md', 'patches/']) {
      expect(text).toContain(entry);
    }
  });
});

describe('applying to a folder gezels may not write', () => {
  it('succeeds as a user action while the gezel write path stays shut', async () => {
    // The gate that makes this project interesting.
    const gate = await svc.context.store.assertWorkspaceWritable(externalProjectId, {
      initiatedByGezel: true,
    });
    expect(gate).toMatchObject({ ok: false, reason: 'external-consent-required' });

    await makePack(externalProjectId, '20', async () => {
      await svc.context.diffpacks.drafts.replaceIn(externalProjectId, '20', {
        path: 'parser.ts',
        find: 'trailing = false',
        replace: 'trailing = true',
      });
    });

    // Nothing has touched the user's folder yet.
    expect(await readFile(join(externalDir, 'parser.ts'), 'utf8')).toBe(
      'const trailing = false;\n',
    );

    const res = await api(`/api/projects/${externalProjectId}/diffpacks/20/apply`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).ok).toBe(true);
    expect(await readFile(join(externalDir, 'parser.ts'), 'utf8')).toBe('const trailing = true;\n');
  });

  it('still refuses a gezel-initiated workspace write to the same project', async () => {
    const res = await api(`/api/projects/${externalProjectId}/workspace/file`, {
      method: 'PUT',
      body: JSON.stringify({ path: 'parser.ts', content: 'sneaky', gezelId: 'rex' }),
    });
    expect(res.status).toBe(403);
    expect(await readFile(join(externalDir, 'parser.ts'), 'utf8')).toBe('const trailing = true;\n');
  });
});
