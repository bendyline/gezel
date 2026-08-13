import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyProjectType } from '../../project-type/apply.js';
import { type RunningService, startService } from '../../service.js';

/**
 * The page-read half of the first-party bridge, driven over real HTTP
 * against a booted service with the SHIPPED checkers type applied (its
 * manifest declares exactly one read: workspace `game.json`). Proves the
 * route contract: manifest-derived scope enforcement, traversal fences,
 * op shapes, and etag stability.
 */

let svc: RunningService;
let baseUrl: string;
let token: string;
let home: string;
let httpFetch: typeof fetch;
let projectId: string;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-page-read-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  token = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;

  const project = await svc.context.store.createProject({ name: 'Read Bridge Game' });
  projectId = project.id;
  await applyProjectType(
    { store: svc.context.store, catalog: svc.context.catalog, home },
    { projectId, typeId: 'checkers' },
  );
}, 60_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

function read(body: unknown, opts: { auth?: boolean; project?: string } = {}) {
  return httpFetch(`${baseUrl}/api/projects/${opts.project ?? projectId}/page-read`, {
    method: 'POST',
    headers: {
      ...(opts.auth === false ? {} : { Authorization: `Bearer ${token}` }),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/projects/:id/page-read', () => {
  it('rejects unauthenticated callers', async () => {
    const res = await read({ op: 'read', source: 'workspace', path: 'game.json' }, { auth: false });
    expect(res.status).toBe(401);
  });

  it('404s an untyped project', async () => {
    const plain = await svc.context.store.createProject({ name: 'Plain Read' });
    const res = await read(
      { op: 'read', source: 'workspace', path: 'game.json' },
      { project: plain.id },
    );
    expect(res.status).toBe(404);
  });

  it('reads a declared file as json text with an etag', async () => {
    const res = await read({ op: 'read', source: 'workspace', path: 'game.json' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      op: string;
      content: string;
      encoding: string;
      etag: string;
      size: number;
    };
    expect(body.op).toBe('read');
    expect(body.encoding).toBe('utf8');
    expect(body.etag).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(() => JSON.parse(body.content)).not.toThrow();
  });

  it('403s a path outside the declared reads (scope is the manifest, not the client)', async () => {
    const workspace = await svc.context.store.projectWorkspaceDir(projectId);
    await writeFile(join(workspace, 'secrets.txt'), 'not for pages');
    const res = await read({ op: 'read', source: 'workspace', path: 'secrets.txt' });
    expect(res.status).toBe(403);
    // Same file, wrong source is also out of scope.
    const cross = await read({ op: 'read', source: 'artifacts', path: 'game.json' });
    expect(cross.status).toBe(403);
  });

  it('blocks traversal shapes before touching the filesystem', async () => {
    for (const path of ['../game.json', '..\\game.json', '/etc/passwd', 'a/../../game.json']) {
      const res = await read({ op: 'read', source: 'workspace', path });
      expect([400, 403]).toContain(res.status);
    }
  });

  it('stat returns a stable etag that flips on change', async () => {
    const first = await read({ op: 'stat', source: 'workspace', path: 'game.json' });
    expect(first.status).toBe(200);
    const a = (await first.json()) as { etag: string };
    const again = await read({ op: 'stat', source: 'workspace', path: 'game.json' });
    const b = (await again.json()) as { etag: string };
    expect(b.etag).toBe(a.etag);

    const workspace = await svc.context.store.projectWorkspaceDir(projectId);
    await writeFile(join(workspace, 'game.json'), JSON.stringify({ changed: Date.now() }));
    const after = await read({ op: 'stat', source: 'workspace', path: 'game.json' });
    const c = (await after.json()) as { etag: string };
    expect(c.etag).not.toBe(a.etag);
  });

  it('list on a file is a 400', async () => {
    const res = await read({ op: 'list', source: 'workspace', path: 'game.json' });
    expect(res.status).toBe(400);
  });

  it('enforces the read cap', async () => {
    const res = await read({
      op: 'read',
      source: 'workspace',
      path: 'game.json',
      maxBytes: 1,
    });
    expect(res.status).toBe(413);
  });

  it('rejects malformed ops at the schema layer', async () => {
    const res = await read({ op: 'delete', source: 'workspace', path: 'game.json' });
    expect(res.status).toBe(422);
  });
});
