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
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKnowledgeSigningKeyPair, signRegistryIndex } from '@bendyline/gezel-knowledge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestCatalog } from '../knowledge/test-catalog-fixture.js';
import { SHARED_ASSETS_ENV } from '../models/storage-roots.js';
import { createKnowledgeAssetsBroker } from './knowledge-assets.js';

let dir: string;
let sharedRoot: string;
let archiveBytes: Buffer;
let digest: string;
let server: Server;
let baseUrl: string;
let anchorsPath: string;
let keys: ReturnType<typeof generateKnowledgeSigningKeyPair>;

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

  server = createServer((req, res) => {
    if (req.url === '/index.json') {
      const registry = signRegistryIndex(
        {
          kind: 'gezel-knowledge-registry',
          formatVersion: 1,
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
              url: `${baseUrl}/archive.gezk`,
              license: { name: 'CC BY-SA 4.0', attributionRequired: true },
            },
          ],
        },
        keys.privateKeyPem,
      );
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(registry));
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
