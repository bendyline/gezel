import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gildeDataDir } from '@bendyline/gezel-catalog';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import type { PageLibrariesResponse, PageLibraryNeedsResponse } from '@bendyline/gezel/pages';
import * as tar from 'tar';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../service.js';

let svc: RunningService;
let home: string;
let registry: Server;
let httpFetch: typeof fetch;
let baseUrl: string;
const downloads: string[] = [];
const saved = {
  gilde: process.env.GEZEL_GILDE_DATA_DIR,
  registry: process.env.GEZEL_PAGE_LIBRARIES_REGISTRY,
};

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-page-library-routes-'));
  process.env.GEZEL_MOCK_PROVIDER = '1';

  const fixture = join(home, 'fixture');
  await mkdir(join(fixture, 'package', 'dist'), { recursive: true });
  await writeFile(
    join(fixture, 'package', 'package.json'),
    JSON.stringify({ name: 'widget', version: '2.1.0' }),
  );
  await writeFile(join(fixture, 'package', 'dist', 'widget.js'), 'export const widget = 1;\n');
  await writeFile(join(fixture, 'package', 'LICENSE'), 'MIT\n');
  const tarballPath = join(home, 'widget.tgz');
  await tar.create({ cwd: fixture, file: tarballPath, gzip: true }, ['package']);
  const tarball = await readFile(tarballPath);

  registry = createServer((request, response) => {
    const origin = `http://127.0.0.1:${(registry.address() as { port: number }).port}`;
    if (request.url === '/widget') {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({ versions: { '2.1.0': { dist: { tarball: `${origin}/widget.tgz` } } } }),
      );
      return;
    }
    downloads.push(request.url ?? '');
    response.end(tarball);
  });
  await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve));

  // The bundled catalog, which boot needs, plus one page library pinned to
  // the fixture's bytes.
  const catalog = join(home, 'gilde');
  await mkdir(catalog);
  const bundled = gildeDataDir();
  for (const entry of await readdir(bundled)) {
    if (entry !== 'page-libraries') await symlink(join(bundled, entry), join(catalog, entry));
  }
  const item = join(catalog, 'page-libraries', 'wi', 'widget');
  await mkdir(join(item, 'versions', '1.0.0'), { recursive: true });
  await writeFile(
    join(item, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'page-library',
      id: 'widget',
      name: 'Widget',
      description: 'A test library.',
      tags: [],
      maintainer: { name: 'test' },
      license: 'MIT',
    }),
  );
  await writeFile(
    join(item, 'versions', '1.0.0', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      version: '1.0.0',
      releasedAt: '2026-11-21T00:00:00Z',
      lines: [
        {
          version: '2.1.0',
          answers: { from: '2.0.0', before: '3.0.0' },
          source: {
            kind: 'npm',
            package: 'widget',
            version: '2.1.0',
            sha256: createHash('sha256').update(tarball).digest('hex'),
          },
          packages: ['widget'],
          include: ['dist/widget.js'],
          module: { default: true, entries: { '.': 'dist/widget.js' } },
          license: 'MIT',
          notice: 'LICENSE',
        },
      ],
    }),
  );
  process.env.GEZEL_GILDE_DATA_DIR = catalog;
  process.env.GEZEL_PAGE_LIBRARIES_REGISTRY = `http://127.0.0.1:${(registry.address() as { port: number }).port}`;

  svc = await startService({ home });
  baseUrl = `${svc.cert ? 'https' : 'http'}://127.0.0.1:${svc.port}`;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  await svc.context.store.writeProjectWorkspaceFile(
    'default',
    'site/index.html',
    [
      '<script type="module">',
      'import { widget } from "widget";',
      'import confetti from "canvas-confetti";',
      '</script>',
    ].join('\n'),
  );
}, 30_000);

afterAll(async () => {
  await svc?.stop();
  await new Promise<void>((resolve) => registry.close(() => resolve()));
  await rm(home, { recursive: true, force: true });
  delete process.env.GEZEL_MOCK_PROVIDER;
  for (const [key, value] of [
    ['GEZEL_GILDE_DATA_DIR', saved.gilde],
    ['GEZEL_PAGE_LIBRARIES_REGISTRY', saved.registry],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}, 30_000);

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await httpFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${svc.clientToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as T };
}

describe('page library routes', () => {
  it('lists what the catalog offers before anything is installed', async () => {
    const { body } = await call<PageLibrariesResponse>('GET', '/api/page-libraries');
    expect(body.autoDownload).toBe(true);
    expect(body.libraries).toEqual([
      expect.objectContaining({
        library: 'widget',
        name: 'Widget',
        description: 'A test library.',
        lines: [
          expect.objectContaining({
            version: '2.1.0',
            forms: ['module'],
            defaults: ['module'],
            installed: false,
            removable: false,
          }),
        ],
      }),
    ]);
  });

  it("downloads what a page needs, says what it can't answer, and pins the version", async () => {
    const { body } = await call<PageLibraryNeedsResponse>(
      'POST',
      '/api/projects/default/page-libraries/needs',
      { path: 'site/index.html', waitMs: 10_000 },
    );
    expect(body.needed).toEqual([
      { library: 'widget', name: 'Widget', version: '2.1.0', ready: true },
    ]);
    expect(body.installed).toEqual(['widget@2.1.0']);
    expect(body.unknown).toEqual([
      { spelling: 'canvas-confetti', from: 'site/index.html', kind: 'package' },
    ]);
    expect(downloads).toEqual(['/widget.tgz']);
    expect(body.available).toEqual([{ name: 'Widget', version: '2', scriptOnly: false }]);
    expect(await svc.context.store.readPageLibraryPins('default')).toEqual({
      widget: { module: '2.1.0' },
    });

    // Asked again, it is already there.
    const again = await call<PageLibraryNeedsResponse>(
      'POST',
      '/api/projects/default/page-libraries/needs',
      { path: 'site/index.html' },
    );
    expect(again.body.installed).toEqual([]);
    expect(again.body.needed[0]?.ready).toBe(true);
    expect(downloads).toHaveLength(1);
  });

  it('refuses a path that is not a workspace page', async () => {
    for (const path of ['../outside.html', 'site/main.js', '/etc/passwd']) {
      const { status } = await call('POST', '/api/projects/default/page-libraries/needs', { path });
      expect(status).toBe(400);
    }
  });

  it('lets the person remove and download a line again', async () => {
    const listed = await call<PageLibrariesResponse>('GET', '/api/page-libraries');
    expect(listed.body.libraries[0]?.lines[0]).toMatchObject({ installed: true, removable: true });

    expect((await call('DELETE', '/api/page-libraries/widget/2.1.0')).status).toBe(200);
    expect((await call('DELETE', '/api/page-libraries/widget/2.1.0')).status).toBe(404);
    const removed = await call<PageLibrariesResponse>('GET', '/api/page-libraries');
    expect(removed.body.libraries[0]?.lines[0]).toMatchObject({ installed: false });

    const installed = await call<{ ok: boolean; ready: boolean }>(
      'POST',
      '/api/page-libraries/install',
      { library: 'widget', version: '2.1.0' },
    );
    expect(installed.body).toEqual({ ok: true, ready: true });
    expect(
      (await call('POST', '/api/page-libraries/install', { library: 'nope', version: '1.0.0' }))
        .status,
    ).toBe(404);
  });

  it('downloads nothing in a store build', async () => {
    await call('DELETE', '/api/page-libraries/widget/2.1.0');
    const before = downloads.length;
    process.env.GEZEL_DISTRIBUTION_PROFILE = 'store';
    try {
      const listed = await call<PageLibrariesResponse>('GET', '/api/page-libraries');
      expect(listed.body.downloads).toMatchObject({
        person: false,
        automatic: false,
        blocked: 'build',
      });
      expect(listed.body.downloads.refusal).toContain('fixed set of page libraries');
      const install = await call('POST', '/api/page-libraries/install', {
        library: 'widget',
        version: '2.1.0',
      });
      expect(install.status).toBe(403);
      const needs = await call<PageLibraryNeedsResponse>(
        'POST',
        '/api/projects/default/page-libraries/needs',
        { path: 'site/index.html', waitMs: 2_000 },
      );
      // Offered only what is installed, which is nothing: the import is unanswered.
      expect(needs.body.needed).toEqual([]);
      expect(needs.body.unknown.map((entry) => entry.spelling)).toContain('widget');
    } finally {
      delete process.env.GEZEL_DISTRIBUTION_PROFILE;
    }
    expect(downloads.length).toBe(before);
  });
});
