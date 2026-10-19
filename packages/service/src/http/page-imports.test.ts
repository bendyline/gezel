import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PageImportTarget } from '@bendyline/gezel';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import type { ServiceContext } from './context.js';
import { pageImportRoutes } from './routes/page-imports.js';

let targets: PageImportTarget[];
vi.mock('../project-type/script-tools.js', () => ({
  resolveProjectTypeManifest: async () => ({ pages: { imports: targets } }),
}));
let home: string;
let workspace: string;
let store: Store;
let app: Hono;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-import-test-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.ensureDefaultProject();
  workspace = await store.projectWorkspaceDir('default');
  targets = [{ id: 'data', source: 'workspace', path: 'data', accept: ['.csv'], maxFileBytes: 64 }];
  app = new Hono();
  app.use('*', async (c, next) => {
    if (c.req.header('x-scopes')) c.set('auth', { scopes: [c.req.header('x-scopes')] } as never);
    await next();
  });
  app.route('/api/projects', pageImportRoutes({ store, catalog: {} } as ServiceContext));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
function upload(
  name = 'sample.csv',
  body: NonNullable<RequestInit['body']> = 'a,b\n1,2',
  scope = 'ui',
  target = 'data',
  signal?: AbortSignal,
) {
  return app.request(
    `/api/projects/default/page-imports?${new URLSearchParams({ name, target })}`,
    { method: 'POST', headers: { 'x-scopes': scope }, body, signal, duplex: 'half' } as RequestInit,
  );
}
it('streams exact bytes and atomically keeps both filenames, including concurrent imports', async () => {
  const bytes = new Uint8Array([0, 255, 128, 13, 10, 42]);
  const first = await upload('sample.csv', bytes);
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({
    path: 'data/sample.csv',
    source: 'workspace',
    size: 6,
  });
  const next = await Promise.all([upload(), upload()]);
  expect(next.map((r) => r.status)).toEqual([200, 200]);
  expect(await readdir(join(workspace, 'data'))).toEqual([
    'sample (1).csv',
    'sample (2).csv',
    'sample.csv',
  ]);
  expect(await readFile(join(workspace, 'data/sample.csv'))).toEqual(Buffer.from(bytes));
});
it('denies undeclared targets, unauthorized callers, traversal, device names, streams and unsupported extensions', async () => {
  for (const scope of ['', 'session', 'product'])
    expect((await upload('a.csv', 'x', scope)).status).toBe(scope ? 403 : 401);
  expect((await upload('a.csv', 'x', 'ui', 'elsewhere')).status).toBe(403);
  for (const name of [
    '../a.csv',
    'C:\\a.csv',
    'data/a.csv',
    'a.csv:stream',
    'CON.csv',
    '.hidden.csv',
    'a.csv ',
    'a.exe',
  ])
    expect((await upload(name)).status, name).toBe(400);
  targets[0]!.path = '../outside';
  expect((await upload()).status).toBe(403);
});
it('honors internal denial and external-folder consent without granting write access', async () => {
  await store.updateProject('default', { managedWorkspaceWritePolicy: 'deny' });
  expect((await upload()).status).toBe(403);
  const targetList = await app.request('/api/projects/default/page-imports', {
    headers: { 'x-scopes': 'ui' },
  });
  expect(await targetList.json()).toMatchObject([{ writable: false }]);
  const external = join(home, 'outside');
  await mkdir(external);
  await store.updateProject('default', {
    workingDir: external,
    managedWorkspaceWritePolicy: 'auto',
  });
  expect((await upload()).status).toBe(403);
  await store.updateProject('default', { managedWorkspaceWritePolicy: 'allow' });
  expect((await upload()).status).toBe(200);
  expect(await readFile(join(external, 'data/sample.csv'), 'utf8')).toBe('a,b\n1,2');
});
it('rejects symlink escapes and leaves oversized streams unpublished', async () => {
  const outside = join(home, 'outside');
  await mkdir(outside);
  await mkdir(workspace, { recursive: true });
  await symlink(
    outside,
    join(workspace, 'data'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  expect((await upload()).status).toBe(400);
  expect(await readdir(outside)).toEqual([]);
  await rm(join(workspace, 'data'));
  expect((await upload('big.csv', 'x'.repeat(65))).status).toBe(413);
  expect(await readdir(workspace)).not.toContain('data');
});
it('rechecks revoked permissions after streaming and cancels without publishing', async () => {
  const body = new ReadableStream(
    {
      async pull(controller) {
        controller.enqueue(new TextEncoder().encode('x'));
        await store.updateProject('default', { managedWorkspaceWritePolicy: 'deny' });
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  expect((await upload('revoked.csv', body)).status).toBe(403);
  await store.updateProject('default', { managedWorkspaceWritePolicy: 'allow' });
  const abort = new AbortController();
  const pending = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('x'));
    },
  });
  const call = upload('cancel.csv', pending, 'ui', 'data', abort.signal);
  setTimeout(() => abort.abort(), 50);
  expect((await call).status).toBe(408);
  expect(await readdir(workspace).catch(() => [])).not.toContain('data');
});
