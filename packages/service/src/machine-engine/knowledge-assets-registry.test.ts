/**
 * Phase-6 broker seam: with `GEZEL_KNOWLEDGE_REGISTRY_URL` configured, the
 * broker locates archives through the SIGNED publisher registry — verifying
 * the registry signature against trust anchors, matching the trusted
 * coordinate exactly (digest included), downloading with the declared size
 * as a hard cap, re-verifying the digest on the bytes, and deleting the
 * ephemeral download after extraction. Requests remain bare coordinates:
 * no URL in this file ever comes from a requesting daemon.
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BundledSource, CatalogService } from '@bendyline/gezel-catalog';
import { generateKnowledgeSigningKeyPair, signRegistryIndex } from '@bendyline/gezel-knowledge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestCatalog } from '../knowledge/test-catalog-fixture.js';
import { SHARED_ASSETS_ENV } from '../models/storage-roots.js';
import { type BrokerInstallEvent, createKnowledgeAssetsBroker } from './knowledge-assets.js';

let dir: string;
let sharedRoot: string;
let archiveBytes: Buffer;
let digest: string;
let server: Server;
let baseUrl: string;
let anchorsPath: string;
let keys: ReturnType<typeof generateKnowledgeSigningKeyPair>;
/** Range headers seen by the flaky archive endpoint, one per request. */
const flakyRequests: string[] = [];

const COORD = { publisherId: 'gezel-tests', catalogId: 'test-notes', version: '1.0.0' };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-knowledge-broker-registry-'));
  sharedRoot = join(dir, 'assets');
  const archivePath = join(dir, 'test-notes-1.0.0.gezk');
  await buildTestCatalog({ outputPath: archivePath, workDir: join(dir, 'work') });
  archiveBytes = await readFile(archivePath);
  digest = createHash('sha256').update(archiveBytes).digest('hex');

  keys = generateKnowledgeSigningKeyPair();
  anchorsPath = join(dir, 'anchors.json');
  await writeFile(
    anchorsPath,
    JSON.stringify([{ keyId: keys.keyId, publicKeyPem: keys.publicKeyPem }]),
    'utf8',
  );

  const registryFor = (archiveUrl: string) =>
    signRegistryIndex(
      {
        kind: 'gezk-registry',
        formatVersion: '0.5',
        publisher: { id: COORD.publisherId, name: 'Gezel Tests' },
        generatedAt: '2026-08-25T00:00:00.000Z',
        catalogs: [
          {
            catalogId: COORD.catalogId,
            version: COORD.version,
            name: 'Test Notes',
            language: 'en',
            documents: 3,
            archiveBytes: archiveBytes.length,
            contentDigest: digest,
            url: archiveUrl,
            license: { name: 'CC BY-SA 4.0', attributionRequired: true },
          },
        ],
      },
      keys.privateKeyPem,
    );
  server = createServer((req, res) => {
    if (req.url === '/index.json' || req.url === '/index-flaky.json') {
      const archive = req.url === '/index.json' ? 'archive.gezk' : 'archive-flaky.gezk';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(registryFor(`${baseUrl}/${archive}`)));
      return;
    }
    if (req.url === '/archive.gezk') {
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-length': String(archiveBytes.length),
      });
      res.end(archiveBytes);
      return;
    }
    if (req.url === '/archive-flaky.gezk') {
      // First request: half the bytes, then the socket dies under the client.
      // Later requests honor Range so the shared downloader can resume.
      flakyRequests.push(req.headers.range ?? '');
      if (flakyRequests.length === 1) {
        res.writeHead(200, {
          'content-type': 'application/zip',
          'content-length': String(archiveBytes.length),
        });
        res.write(archiveBytes.subarray(0, Math.floor(archiveBytes.length / 2)), () => {
          res.socket?.destroy();
        });
        return;
      }
      const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
      const start = range ? Number(range[1]) : 0;
      res.writeHead(range ? 206 : 200, {
        'content-type': 'application/zip',
        'content-length': String(archiveBytes.length - start),
        ...(range
          ? { 'content-range': `bytes ${start}-${archiveBytes.length - 1}/${archiveBytes.length}` }
          : {}),
      });
      res.end(archiveBytes.subarray(start));
      return;
    }
    if (req.url?.startsWith('/datasets/Bendyline/test-notes/resolve/')) {
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-length': String(archiveBytes.length),
      });
      res.end(archiveBytes);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}, 60_000);

afterAll(async () => {
  server?.close();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

function brokerEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    [SHARED_ASSETS_ENV]: sharedRoot,
    GEZEL_KNOWLEDGE_REGISTRY_URL: `${baseUrl}/index.json`,
    GEZEL_KNOWLEDGE_TRUST_ANCHORS: anchorsPath,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('knowledge broker registry-URL resolution', () => {
  it('ensures a coordinate through the signed registry and cleans up the download', async () => {
    const broker = createKnowledgeAssetsBroker(brokerEnv());
    const outcome = await broker.ensure({ ...COORD, expectedDigest: digest });
    expect(outcome.status, JSON.stringify(outcome)).toBe('ready');
    if (outcome.status !== 'ready') return;
    expect(await stat(join(outcome.path, 'manifest.json')).catch(() => null)).not.toBeNull();

    // Ephemeral download removed after extraction.
    const downloads = await readdir(join(sharedRoot, 'knowledge', 'downloads')).catch(() => []);
    expect(downloads).toEqual([]);

    const inventory = await broker.inventory();
    expect(inventory.catalogs.map((c) => c.catalogId)).toContain(COORD.catalogId);
  }, 60_000);

  it('resumes a broker download after the socket drops mid-archive', async () => {
    const broker = createKnowledgeAssetsBroker(
      brokerEnv({
        [SHARED_ASSETS_ENV]: join(dir, 'assets-flaky'),
        GEZEL_KNOWLEDGE_REGISTRY_URL: `${baseUrl}/index-flaky.json`,
      }),
    );
    const outcome = await broker.ensure({ ...COORD, expectedDigest: digest });
    expect(outcome.status, JSON.stringify(outcome)).toBe('ready');
    expect(flakyRequests.length).toBeGreaterThanOrEqual(2);
    expect(flakyRequests.slice(1).some((range) => range.startsWith('bytes='))).toBe(true);
  }, 60_000);

  it('refuses a coordinate whose digest the registry does not carry', async () => {
    const broker = createKnowledgeAssetsBroker(brokerEnv());
    const outcome = await broker.ensure({ ...COORD, expectedDigest: 'd'.repeat(64) });
    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') expect(outcome.code).toBe('not-found');
  });

  it('ignores the registry URL entirely when no trust anchor can verify it', async () => {
    // Fresh shared root: the coordinate must not already be installed there.
    const broker = createKnowledgeAssetsBroker(
      brokerEnv({
        [SHARED_ASSETS_ENV]: join(dir, 'assets-unanchored'),
        GEZEL_KNOWLEDGE_TRUST_ANCHORS: undefined,
      }),
    );
    const outcome = await broker.ensure({ ...COORD, expectedDigest: digest });
    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') expect(outcome.code).toBe('not-found');
  });
});

async function collectStream(
  broker: ReturnType<typeof createKnowledgeAssetsBroker>,
  key: string,
): Promise<BrokerInstallEvent[]> {
  const seen: BrokerInstallEvent[] = [];
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      resolve(seen);
    };
    unsubscribe = broker.installs.subscribe(key, (event) => {
      seen.push(event);
      if (event.type === 'done' || event.type === 'error') finish();
    });
    if (!unsubscribe) finish();
    else if (settled) unsubscribe();
  });
}

describe('knowledge broker gilde-pin resolution', () => {
  let gildeRoot: string;
  let priorHfBase: string | undefined;

  beforeAll(async () => {
    gildeRoot = join(dir, 'gilde-data');
    const itemDir = join(gildeRoot, 'knowledge-catalogs', 'te', 'test-notes');
    await mkdir(join(itemDir, 'versions', '1.0.0'), { recursive: true });
    await writeFile(
      join(itemDir, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        kind: 'knowledge-catalog',
        id: 'test-notes',
        name: 'Test Notes',
        description: 'Fixture catalog pinned by the shipped content.',
        tags: ['test'],
        maintainer: { name: 'Gezel Tests' },
        publisherId: COORD.publisherId,
        language: 'en',
        yankedVersions: [],
      }),
    );
    await writeFile(
      join(itemDir, 'versions', '1.0.0', 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        version: '1.0.0',
        releasedAt: '2026-09-01T00:00:00.000Z',
        formatVersion: '0.5',
        huggingface: {
          repo: 'Bendyline/test-notes',
          revision: 'a'.repeat(40),
          path: 'releases/1.0.0/test-notes-1.0.0.gezk',
        },
        sha256: digest,
        archiveBytes: archiveBytes.length,
        uncompressedBytes: archiveBytes.length * 2,
        documents: 2,
        chunks: 4,
        embeddingProfile: { id: 'bge-small-en-v1.5@1', modelRepo: 'Xenova/bge-small-en-v1.5' },
        topics: [{ id: 'joinery', name: 'Joinery' }],
      }),
    );
    priorHfBase = process.env.GEZEL_HF_BASE_URL;
    process.env.GEZEL_HF_BASE_URL = baseUrl;
  });

  afterAll(() => {
    if (priorHfBase === undefined) delete process.env.GEZEL_HF_BASE_URL;
    else process.env.GEZEL_HF_BASE_URL = priorHfBase;
  });

  const catalog = () => new CatalogService([new BundledSource(gildeRoot)]);

  it('resolves a coordinate through the shipped catalog pin and streams the install', async () => {
    const sharedAssets = join(dir, 'assets-gilde');
    const broker = createKnowledgeAssetsBroker(
      brokerEnv({ [SHARED_ASSETS_ENV]: sharedAssets, GEZEL_KNOWLEDGE_REGISTRY_URL: undefined }),
      { catalog: catalog() },
    );
    const { key, alreadyRunning } = broker.startStream({ ...COORD, expectedDigest: digest });
    expect(alreadyRunning).toBe(false);
    expect(broker.startStream({ ...COORD, expectedDigest: digest }).alreadyRunning).toBe(true);
    const events = await collectStream(broker, key);
    expect(events.at(-1), JSON.stringify(events)).toMatchObject({
      type: 'done',
      storageScope: 'machine-shared',
      ref: { catalogId: COORD.catalogId, contentDigest: digest, storageScope: 'machine-shared' },
    });
    expect(events.some((e) => e.type === 'progress' && e.phase === 'download')).toBe(true);
    expect(events.some((e) => e.type === 'verifying')).toBe(true);
    expect(events.some((e) => e.type === 'progress' && e.phase === 'extract')).toBe(true);
    expect((await broker.inventory()).catalogs.map((c) => c.catalogId)).toContain(COORD.catalogId);

    // The ephemeral download is gone, and a repeat ensure needs no download.
    const downloads = await readdir(join(sharedAssets, 'knowledge', 'downloads')).catch(() => []);
    expect(downloads).toEqual([]);
    expect(await broker.ensure({ ...COORD, expectedDigest: digest })).toMatchObject({
      status: 'ready',
    });
  }, 60_000);

  it('ignores a catalog pin whose digest differs from the coordinate', async () => {
    const broker = createKnowledgeAssetsBroker(
      brokerEnv({
        [SHARED_ASSETS_ENV]: join(dir, 'assets-gilde-mismatch'),
        GEZEL_KNOWLEDGE_REGISTRY_URL: undefined,
      }),
      { catalog: catalog() },
    );
    expect(await broker.ensure({ ...COORD, expectedDigest: 'e'.repeat(64) })).toMatchObject({
      status: 'error',
      code: 'not-found',
    });
    // The registry marks the job finished a tick after its terminal event.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(broker.cancel({ ...COORD, expectedDigest: 'e'.repeat(64) })).toBe(false);
  });
});
