/**
 * The gilde-backed install path: a `knowledge-catalog` entry resolves to a
 * commit-pinned Hugging Face URL (served locally through GEZEL_HF_BASE_URL),
 * the pinned sha256 and identity gate the install, cancel leaves a resumable
 * partial keyed by the digest, and the auto-updater resumes it.
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GezelConfig, HistoryEvent } from '@bendyline/gezel';
import { BundledSource, CatalogService } from '@bendyline/gezel-catalog';
import { extractGezkVerified } from '@bendyline/gezel-knowledge';
import { knowledgeCatalogsDir } from '@bendyline/gezel/paths';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HistoryManager } from '../history/manager.js';
import { sharedKnowledgeVersionDir } from '../machine-engine/knowledge-assets.js';
import { SHARED_ASSETS_ENV } from '../models/storage-roots.js';
import { createInProcessCatalogHost } from './catalog-host.js';
import type { KnowledgeInstallEvent } from './install.js';
import { KnowledgeManager } from './manager.js';
import type { SharedKnowledgeInstaller } from './shared-install.js';
import { buildTestCatalog } from './test-catalog-fixture.js';

const REPO = 'Bendyline/test-notes';
const REVISION = 'a'.repeat(40);

let dir: string;
let home: string;
let gildeRoot: string;
let server: Server;
let manager: KnowledgeManager;
const archives = new Map<string, Buffer>();
const requests: Array<{ path: string; range?: string }> = [];
const history: Array<Omit<HistoryEvent, 'id' | 'at'>> = [];
/** Drop the next response halfway through, like a flaky connection. */
let dropNext = false;
const priorHfBase = process.env.GEZEL_HF_BASE_URL;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeGildeEntry(id: string, versions: Array<{ version: string; bytes: Buffer }>) {
  const itemDir = join(gildeRoot, 'knowledge-catalogs', id.slice(0, 2), id);
  await mkdir(itemDir, { recursive: true });
  await writeFile(
    join(itemDir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'knowledge-catalog',
      id,
      name: `Test Notes (${id})`,
      description: 'Fixture catalog served from a local Hugging Face stand-in.',
      tags: ['test'],
      maintainer: { name: 'Gezel Tests' },
      license: 'MIT',
      publisherId: 'gezel-tests',
      language: 'en',
      category: 'reference',
      yankedVersions: [],
    }),
  );
  for (const { version, bytes } of versions) {
    const path = `releases/${version}/${id}-${version}.gezk`;
    archives.set(path, bytes);
    const versionDir = join(itemDir, 'versions', version);
    await mkdir(versionDir, { recursive: true });
    await writeFile(
      join(versionDir, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        version,
        releasedAt: `2026-09-0${versions.indexOf({ version, bytes }) + 1}T00:00:00.000Z`,
        formatVersion: '0.5',
        huggingface: { repo: REPO, revision: REVISION, path },
        sha256: sha256(bytes),
        archiveBytes: bytes.length,
        uncompressedBytes: bytes.length * 2,
        documents: 2,
        chunks: 4,
        embeddingProfile: { id: 'bge-small-en-v1.5@1', modelRepo: 'Xenova/bge-small-en-v1.5' },
        topics: [{ id: 'joinery', name: 'Joinery' }],
      }),
    );
  }
}

async function runJob(jobId: string): Promise<KnowledgeInstallEvent[]> {
  const events: KnowledgeInstallEvent[] = [];
  await new Promise<void>((resolve) => {
    const unsubscribe = manager.subscribeJob(jobId, (event) => {
      events.push(event);
      if (event.type === 'done' || event.type === 'error') {
        unsubscribe?.();
        resolve();
      }
    });
    if (!unsubscribe) resolve();
  });
  return events;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-knowledge-gilde-'));
  home = join(dir, 'home');
  gildeRoot = join(dir, 'gilde-data');
  const v1 = join(dir, 'test-notes-1.0.0.gezk');
  const v2 = join(dir, 'test-notes-2.0.0.gezk');
  await buildTestCatalog({ outputPath: v1, workDir: join(dir, 'work-1') });
  await buildTestCatalog({ outputPath: v2, workDir: join(dir, 'work-2'), version: '2.0.0' });
  const v1Bytes = await readFile(v1);
  await writeGildeEntry('test-notes', [{ version: '1.0.0', bytes: v1Bytes }]);
  // A second entry that pins test-notes' bytes under another id: the digest
  // matches, the identity does not.
  await writeGildeEntry('other-notes', [{ version: '1.0.0', bytes: v1Bytes }]);
  archives.set('releases/2.0.0/test-notes-2.0.0.gezk', await readFile(v2));

  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const prefix = `/datasets/${REPO}/resolve/${REVISION}/`;
    const path = url.pathname.startsWith(prefix)
      ? decodeURIComponent(url.pathname.slice(prefix.length))
      : '';
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    requests.push({ path, ...(req.headers.range ? { range: req.headers.range } : {}) });
    const bytes = archives.get(path);
    if (!bytes || url.searchParams.get('download') !== 'true') {
      res.writeHead(404);
      res.end();
      return;
    }
    if (dropNext) {
      dropNext = false;
      res.writeHead(200, { 'content-length': String(bytes.length) });
      res.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
      setTimeout(() => res.destroy(), 30);
      return;
    }
    const from = range ? Number.parseInt(range[1] as string, 10) : 0;
    if (from > 0) {
      res.writeHead(206, {
        'content-range': `bytes ${from}-${bytes.length - 1}/${bytes.length}`,
        'content-length': String(bytes.length - from),
      });
      res.end(bytes.subarray(from));
      return;
    }
    res.writeHead(200, { 'content-length': String(bytes.length) });
    res.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  process.env.GEZEL_HF_BASE_URL = `http://127.0.0.1:${port}`;

  manager = new KnowledgeManager({
    home,
    host: await createInProcessCatalogHost(),
    catalog: new CatalogService([new BundledSource(gildeRoot)]),
    history: {
      log: async (event: Omit<HistoryEvent, 'id' | 'at'>) => {
        history.push(event);
      },
    } as unknown as HistoryManager,
    readConfig: async () => ({}) as GezelConfig,
  });
  await manager.start();
}, 60_000);

afterAll(async () => {
  await manager.stop();
  server.close();
  if (priorHfBase === undefined) delete process.env.GEZEL_HF_BASE_URL;
  else process.env.GEZEL_HF_BASE_URL = priorHfBase;
  await rm(dir, { recursive: true, force: true });
});

describe('KnowledgeManager — gilde catalog installs', () => {
  it('lists the catalog entries before anything is installed', async () => {
    const available = await manager.available();
    expect(available.map((c) => c.id)).toEqual(['other-notes', 'test-notes']);
    const entry = available.find((c) => c.id === 'test-notes');
    expect(entry).toMatchObject({
      publisherId: 'gezel-tests',
      version: '1.0.0',
      huggingface: { repo: REPO, revision: REVISION },
      installing: false,
      incompleteDownload: false,
      sharedOnDevice: false,
    });
    expect(entry?.installed).toBeUndefined();
    expect(await manager.updates()).toEqual([]);
  });

  it('installs from the pinned Hugging Face URL and records the gilde source', async () => {
    const { jobId, alreadyRunning } = manager.startInstall({ kind: 'catalog', id: 'test-notes' });
    expect(jobId).toBe('test-notes');
    expect(alreadyRunning).toBe(false);
    expect(manager.startInstall({ kind: 'catalog', id: 'test-notes' }).alreadyRunning).toBe(true);
    const events = await runJob(jobId);
    const done = events.find((e) => e.type === 'done');
    expect(done, JSON.stringify(events)).toMatchObject({
      type: 'done',
      storageScope: 'user',
      ref: { publisherId: 'gezel-tests', catalogId: 'test-notes', version: '1.0.0' },
    });
    expect(events.some((e) => e.type === 'verifying')).toBe(true);

    const [status] = await manager.list();
    expect(status).toMatchObject({ source: 'gilde', updateAvailable: false, mounted: true });
    const available = await manager.available();
    expect(available.find((c) => c.id === 'test-notes')?.installed).toMatchObject({
      version: '1.0.0',
      storageScope: 'user',
      enabled: true,
      updateAvailable: false,
    });
    expect(history.at(-1)).toMatchObject({
      kind: 'knowledge.catalog.installed',
      details: { catalogId: 'test-notes', version: '1.0.0', source: 'gilde' },
    });
    const job = manager.getJob(jobId);
    expect(job?.finished).toBe(true);
    expect(job?.events.at(-1)?.type).toBe('done');
    expect(manager.activeInstalls()).toEqual([]);
  }, 30_000);

  it('refuses an archive whose identity differs from the entry that pinned it', async () => {
    const { jobId } = manager.startInstall({ kind: 'catalog', id: 'other-notes' });
    const events = await runJob(jobId);
    const last = events.at(-1);
    expect(last?.type).toBe('error');
    if (last?.type !== 'error') return;
    expect(last.error).toContain('catalog identity mismatch');
    expect(last.error).toContain('gezel-tests/other-notes@1.0.0');
    expect(history.at(-1)?.kind).toBe('knowledge.catalog.install_failed');
    expect((await manager.list()).map((c) => c.ref.catalogId)).toEqual(['test-notes']);
  }, 30_000);

  it('a newer gilde version is offered, a cancelled download stays resumable, and auto-update resumes it', async () => {
    const v2Bytes = archives.get('releases/2.0.0/test-notes-2.0.0.gezk');
    if (!v2Bytes) throw new Error('fixture missing');
    await writeGildeEntry('test-notes', [
      { version: '1.0.0', bytes: archives.get('releases/1.0.0/test-notes-1.0.0.gezk') as Buffer },
      { version: '2.0.0', bytes: v2Bytes },
    ]);
    await manager.stop();
    manager = new KnowledgeManager({
      home,
      host: await createInProcessCatalogHost(),
      catalog: new CatalogService([new BundledSource(gildeRoot)]),
      history: {
        log: async (event: Omit<HistoryEvent, 'id' | 'at'>) => {
          history.push(event);
        },
      } as unknown as HistoryManager,
      readConfig: async () => ({}) as GezelConfig,
    });
    await manager.start();

    const updates = await manager.updates();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      catalogId: 'test-notes',
      installedVersion: '1.0.0',
      availableVersion: '2.0.0',
      contentDigest: sha256(v2Bytes),
      archiveBytes: v2Bytes.length,
    });
    expect((await manager.list())[0]).toMatchObject({
      updateAvailable: true,
      availableVersion: '2.0.0',
    });

    // Start the update over a connection that drops halfway, then cancel
    // before the retry: the partial stays on disk under the digest key.
    dropNext = true;
    const { jobId } = manager.startInstall({ kind: 'catalog', id: 'test-notes', version: '2.0.0' });
    const cancelled = await new Promise<KnowledgeInstallEvent[]>((resolve) => {
      const events: KnowledgeInstallEvent[] = [];
      let requested = false;
      const unsubscribe = manager.subscribeJob(jobId, (event) => {
        events.push(event);
        if (!requested && (event.type === 'progress' || event.type === 'retrying')) {
          requested = true;
          expect(manager.cancelJob(jobId)).toBe(true);
        }
        if (event.type === 'done' || event.type === 'error') {
          unsubscribe?.();
          resolve(events);
        }
      });
    });
    expect(cancelled.at(-1)).toMatchObject({ type: 'error', error: 'install cancelled' });

    const incomplete = await manager.listIncompleteDownloads();
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]).toMatchObject({
      key: sha256(v2Bytes).slice(0, 16),
      resumable: true,
      catalogId: 'test-notes',
      archiveBytes: v2Bytes.length,
    });
    expect(incomplete[0]?.bytes).toBeGreaterThan(0);
    expect(incomplete[0]?.bytes).toBeLessThan(v2Bytes.length);
    expect((await manager.available()).find((c) => c.id === 'test-notes')).toMatchObject({
      incompleteDownload: true,
      installed: { version: '1.0.0', updateAvailable: true },
    });

    // Opt the entry into auto-update; the check starts the install, which
    // resumes the partial with a Range request.
    const entry = manager.registry.find('gezel-tests', 'test-notes');
    if (!entry) throw new Error('registry entry missing');
    manager.registry.upsert(entry.ref, { autoUpdate: true });
    requests.length = 0;
    expect(await manager.checkAutoUpdates()).toEqual(['test-notes@2.0.0']);
    const events = await runJob('test-notes');
    expect(events.at(-1), JSON.stringify(events)).toMatchObject({
      type: 'done',
      ref: { version: '2.0.0' },
    });
    expect(requests.some((r) => r.range !== undefined)).toBe(true);
    expect((await manager.list())[0]).toMatchObject({
      ref: { version: '2.0.0' },
      source: 'gilde',
      updateAvailable: false,
    });
    expect(history.at(-1)).toMatchObject({
      kind: 'knowledge.catalog.updated',
      details: { previousVersion: '1.0.0', version: '2.0.0' },
    });
    expect(
      await stat(join(knowledgeCatalogsDir(home), 'gezel-tests', 'test-notes', '1.0.0')).catch(
        () => null,
      ),
    ).toBeNull();
    expect(await manager.listIncompleteDownloads()).toEqual([]);
    expect(await manager.checkAutoUpdates()).toEqual([]);
  }, 60_000);

  it('deletes a stray partial download and refuses malformed keys', async () => {
    const { knowledgeDownloadsDir } = await import('@bendyline/gezel/paths');
    const downloads = knowledgeDownloadsDir(home);
    await mkdir(downloads, { recursive: true });
    await writeFile(join(downloads, `${'f'.repeat(16)}.gezk.partial`), Buffer.alloc(10));
    const stray = await manager.listIncompleteDownloads();
    expect(stray).toHaveLength(1);
    expect(stray[0]).toMatchObject({ key: 'f'.repeat(16), resumable: false, bytes: 10 });
    expect(await manager.deleteIncompleteDownload('../etc')).toBe(false);
    expect(await manager.deleteIncompleteDownload('f'.repeat(16))).toBe(true);
    expect(await manager.listIncompleteDownloads()).toEqual([]);
  });
});

describe('KnowledgeManager — shared placement through the machine broker', () => {
  it('adopts the broker copy, drops the private bytes, and installs privately when the broker cannot help', async () => {
    const sharedAssets = join(dir, 'shared-assets');
    const sharedRoot = join(sharedAssets, 'knowledge');
    const v2Bytes = archives.get('releases/2.0.0/test-notes-2.0.0.gezk');
    if (!v2Bytes) throw new Error('fixture missing');
    const coordinate = {
      publisherId: 'gezel-tests',
      catalogId: 'test-notes',
      version: '2.0.0',
      expectedDigest: sha256(v2Bytes),
    };
    const calls: string[] = [];
    let outcome: 'ready' | 'unavailable' = 'ready';
    const installer: SharedKnowledgeInstaller = {
      available: () => true,
      ensure: async (coord, onEvent) => {
        calls.push(`${coord.catalogId}@${coord.version}`);
        if (outcome === 'unavailable') return { status: 'unavailable', reason: 'older gilde' };
        onEvent({ type: 'progress', phase: 'download', bytesDone: 1, bytesTotal: 2 });
        const target = sharedKnowledgeVersionDir(sharedRoot, coord);
        if (!(await stat(join(target, 'manifest.json')).catch(() => null))) {
          await extractGezkVerified(join(dir, 'test-notes-2.0.0.gezk'), target);
        }
        await writeFile(
          join(sharedRoot, 'inventory.json'),
          JSON.stringify({
            version: 1,
            catalogs: [
              {
                publisherId: coord.publisherId,
                catalogId: coord.catalogId,
                version: coord.version,
                contentDigest: coord.expectedDigest,
                publishedAt: '2026-09-03T00:00:00.000Z',
                bytes: v2Bytes.length,
              },
            ],
          }),
        );
        return { status: 'ready' };
      },
      cancel: async () => false,
    };

    await manager.stop();
    manager = new KnowledgeManager({
      home,
      host: await createInProcessCatalogHost(),
      env: { ...process.env, [SHARED_ASSETS_ENV]: sharedAssets },
      catalog: new CatalogService([new BundledSource(gildeRoot)]),
      history: {
        log: async (event: Omit<HistoryEvent, 'id' | 'at'>) => {
          history.push(event);
        },
      } as unknown as HistoryManager,
      readConfig: async () => ({}) as GezelConfig,
      sharedInstaller: installer,
    });
    await manager.start();
    expect((await manager.list())[0]?.ref.storageScope).toBe('user');

    const { jobId } = manager.startInstall({ kind: 'catalog', id: 'test-notes', version: '2.0.0' });
    const events = await runJob(jobId);
    expect(events.at(-1), JSON.stringify(events)).toMatchObject({
      type: 'done',
      storageScope: 'machine-shared',
      ref: {
        version: '2.0.0',
        storageScope: 'machine-shared',
        contentDigest: coordinate.expectedDigest,
      },
    });
    expect(events.some((e) => e.type === 'progress' && e.phase === 'download')).toBe(true);
    expect(calls).toEqual(['test-notes@2.0.0']);
    expect((await manager.list())[0]).toMatchObject({
      ref: { storageScope: 'machine-shared' },
      mounted: true,
      source: 'gilde',
    });
    expect(
      await stat(join(knowledgeCatalogsDir(home), 'gezel-tests', 'test-notes')).catch(() => null),
    ).toBeNull();
    expect((await manager.available()).find((c) => c.id === 'test-notes')).toMatchObject({
      sharedOnDevice: true,
      installed: { storageScope: 'machine-shared', version: '2.0.0' },
    });
    const hits = await manager.searchUnified('dovetail corner joint', {
      vector: null,
      maxResults: 5,
    });
    expect(hits.length).toBeGreaterThan(0);

    // An explicit private placement never consults the broker.
    calls.length = 0;
    const privateJob = manager.startInstall({
      kind: 'catalog',
      id: 'test-notes',
      version: '2.0.0',
      placement: 'user',
    });
    expect((await runJob(privateJob.jobId)).at(-1)).toMatchObject({
      type: 'done',
      storageScope: 'user',
    });
    expect(calls).toEqual([]);
    expect((await manager.list())[0]?.ref.storageScope).toBe('user');

    // A broker that cannot resolve the coordinate falls back to a private install.
    outcome = 'unavailable';
    await manager.remove('test-notes');
    const fallback = manager.startInstall({ kind: 'catalog', id: 'test-notes', version: '2.0.0' });
    expect((await runJob(fallback.jobId)).at(-1)).toMatchObject({
      type: 'done',
      storageScope: 'user',
    });
    expect(calls).toEqual(['test-notes@2.0.0']);
  }, 60_000);
});
