import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BundledSource, CatalogService } from '@bendyline/gezel-catalog';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../fs/store.js';
import type { ServiceContext } from '../context.js';
import { PreviewCapabilityStore } from '../preview-capability.js';
import { previewRoutes } from './preview.js';

let home: string;
let dataDir: string;
let store: Store;
let catalog: CatalogService;
let projectId: string;
let capabilities: PreviewCapabilityStore;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'preview-type-home-'));
  dataDir = await mkdtemp(join(tmpdir(), 'preview-type-data-'));
  store = new Store({ home });
  await store.ensureLayout();

  // A bundled project type with a pages/ tree.
  const itemDir = join(dataDir, 'project-types', 'da', 'dash-type');
  const vdir = join(itemDir, 'versions', '1.0.0');
  await mkdir(join(vdir, 'pages', 'dashboard'), { recursive: true });
  await writeFile(
    join(itemDir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'project-type',
      id: 'dash-type',
      name: 'Dash',
      description: 'fixture',
      tags: [],
      maintainer: { name: 'Test' },
      yankedVersions: [],
    }),
  );
  await writeFile(
    join(vdir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      version: '1.0.0',
      releasedAt: '2026-07-06T00:00:00Z',
      pages: { entry: 'dashboard/index.html' },
    }),
  );
  await writeFile(
    join(vdir, 'pages', 'dashboard', 'index.html'),
    '<!doctype html><head></head><body>DASHBOARD</body>',
  );
  await writeFile(join(vdir, 'pages', 'dashboard', 'style.css'), 'body{color:red}');

  catalog = new CatalogService([new BundledSource({ dataDir, noIndex: true })]);
  capabilities = new PreviewCapabilityStore();

  const project = await store.createProject({ name: 'Dash Project' });
  projectId = project.id;
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

function app(capabilityStore = capabilities) {
  // Mount under `/preview` exactly as the server does — the route strips that
  // prefix from `c.req.path` to compute the file path.
  const root = new Hono();
  root.route(
    '/preview',
    previewRoutes({ store, catalog } as unknown as ServiceContext, capabilityStore),
  );
  return root;
}

function previewUrl(path: string, entryPath = 'dashboard/index.html'): string {
  const minted = capabilities.mint({ source: 'type', projectId, entryPath });
  return `/preview/${minted.token}/type/${projectId}/${path}`;
}

async function stampType(): Promise<void> {
  await store.updateProject(projectId, {
    projectType: {
      id: 'dash-type',
      version: '1.0.0',
      source: 'bundled',
      appliedAt: '2026-07-06T00:00:00Z',
    },
  });
}

describe('preview route — type source', () => {
  it('serves a page from the applied type and injects the log shim', async () => {
    await stampType();
    const res = await app().request(previewUrl('dashboard/index.html'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('DASHBOARD');
    // The HTML preview shims are injected.
    expect(body).toContain('__gezelPreviewLog');
    expect(body).toContain('__gezel-preview-frame');
  });

  it('serves a relative asset (css) from the pages tree', async () => {
    await stampType();
    const res = await app().request(previewUrl('dashboard/style.css'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
    expect(await res.text()).toContain('color:red');
  });

  it('404s when the project has no applied project type', async () => {
    const res = await app().request(previewUrl('dashboard/index.html'));
    expect(res.status).toBe(404);
  });

  it('blocks path traversal out of the pages tree', async () => {
    await stampType();
    // Percent-encoded `..` survives URL normalization; the handler decodes it,
    // and catalog.readItemFile rejects the `..` segment — no escape to
    // manifest.json a level up from pages/.
    const res = await app().request(previewUrl('%2e%2e/manifest.json'));
    expect(res.status).not.toBe(200);
  });

  it('returns 410 after a preview capability expires', async () => {
    await stampType();
    let now = 0;
    const expiring = new PreviewCapabilityStore({
      ttlMs: 100,
      absoluteTtlMs: 100,
      now: () => now,
    });
    const minted = expiring.mint({
      source: 'type',
      projectId,
      entryPath: 'dashboard/index.html',
    });
    now = 101;
    const res = await app(expiring).request(
      `/preview/${minted.token}/type/${projectId}/dashboard/index.html`,
    );
    expect(res.status).toBe(410);
  });
});
