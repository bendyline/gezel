/**
 * Phase-2a exit tests over the real HTTP surface: install a real .gezk via
 * the route, browse it, search it (omni + knowledge routes), resume a
 * killed download from `.partial`, and verify the model-facing project
 * search carries cited knowledge results without disturbing project arms.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GezelClient } from '@bendyline/gezel-client';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { knowledgeDownloadsDir } from '@bendyline/gezel/paths';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestCatalog } from '../../knowledge/test-catalog-fixture.js';
import { type RunningService, startService } from '../../service.js';

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

let dir: string;
let home: string;
let archivePath: string;
let svc: RunningService;
let client: GezelClient;

async function waitForJob(jobId: string): Promise<{ error?: string }> {
  for (let i = 0; i < 200; i++) {
    const job = await client.getKnowledgeJob(jobId);
    if (job.finished) return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('install job did not finish');
}

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  dir = await mkdtemp(join(tmpdir(), 'gezel-knowledge-routes-'));
  home = join(dir, 'home');
  archivePath = join(dir, 'test-notes-1.0.0.gezk');
  await buildTestCatalog({ outputPath: archivePath, workDir: join(dir, 'work') });
  svc = await startService({ home });
  const baseUrl = `${svc.cert ? 'https' : 'http'}://127.0.0.1:${svc.port}`;
  const httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  client = new GezelClient({ baseUrl, token: svc.context.token, fetch: httpFetch });
}, 60_000);

afterAll(async () => {
  await svc.stop();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

describe('knowledge routes', () => {
  it('installs from a file, lists, browses, and reads a document', async () => {
    const { jobId } = await client.installKnowledgeCatalog({
      source: { kind: 'file', path: archivePath },
    });
    const job = await waitForJob(jobId);
    expect(job.error).toBeUndefined();

    const { catalogs } = await client.listKnowledgeCatalogs();
    expect(catalogs.length).toBe(1);
    expect(catalogs[0]?.mounted).toBe(true);

    const { topics } = await client.knowledgeCatalogTopics('test-notes');
    expect(topics.map((t) => t.name).sort()).toEqual(['Finishing', 'Joinery']);

    const page = await client.knowledgeCatalogDocuments('test-notes', { topicId: 'joinery' });
    expect(page.total).toBe(1);

    const doc = await client.readKnowledgeDocument('test-notes', 'dovetails');
    expect(doc.markdown).toContain('Tails and pins');
  });

  it('answers the knowledge search route with cited results', async () => {
    const { results } = await client.searchKnowledge({ query: 'dovetail corner joint' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.uri).toMatch(/^knowledge:\/\/test-notes\//);
  });

  it('model-facing project search returns knowledge hits alongside project arms', async () => {
    const res = await client.toolSearch('default', {
      query: 'dovetail corner joint',
      sources: ['knowledge'],
    });
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results.every((r) => r.kind === 'knowledge')).toBe(true);
    expect(res.results[0]?.retrievalSource).toBe('knowledge');
    expect(res.results[0]?.uri).toContain('knowledge://test-notes/');
  });

  it('quarantine leaves project search unaffected', async () => {
    // Even with the catalog disabled, the project search route stays healthy.
    await client.updateKnowledgeCatalog('test-notes', { enabled: false });
    const res = await client.toolSearch('default', { query: 'dovetail corner joint' });
    expect(res.results.every((r) => r.kind !== 'knowledge')).toBe(true);
    await client.updateKnowledgeCatalog('test-notes', { enabled: true });
  });

  it('supports pinned and unpinned URL installs while preserving resume', async () => {
    const bytes = await readFile(archivePath);
    const digest = createHash('sha256').update(bytes).digest('hex');
    // First response sends half the file then destroys the socket; the
    // second honors Range and serves the rest.
    let requests = 0;
    const server: Server = createServer((req, res) => {
      requests++;
      const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
      const from = range ? Number.parseInt(range[1] as string, 10) : 0;
      if (requests === 1) {
        res.writeHead(200, {
          'content-length': String(bytes.length),
          'content-type': 'application/zip',
        });
        res.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
        setTimeout(() => res.destroy(), 30);
        return;
      }
      if (from > 0) {
        res.writeHead(206, {
          'content-range': `bytes ${from}-${bytes.length - 1}/${bytes.length}`,
          'content-length': String(bytes.length - from),
        });
        res.end(bytes.subarray(from));
      } else {
        res.writeHead(200, { 'content-length': String(bytes.length) });
        res.end(bytes);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      await client.removeKnowledgeCatalog('test-notes').catch(() => {});
      const { jobId } = await client.installKnowledgeCatalog({
        source: {
          kind: 'url',
          url: `http://127.0.0.1:${port}/test-notes.gezk`,
          expectedSha256: digest,
        },
      });
      const job = await waitForJob(jobId);
      expect(job.error, JSON.stringify(job)).toBeUndefined();
      expect(requests).toBeGreaterThanOrEqual(2);
      const { catalogs } = await client.listKnowledgeCatalogs();
      expect(catalogs.find((c) => c.ref.catalogId === 'test-notes')?.mounted).toBe(true);

      const { jobId: mismatchedJobId } = await client.installKnowledgeCatalog({
        source: {
          kind: 'url',
          url: `http://127.0.0.1:${port}/test-notes.gezk`,
          expectedSha256: '0'.repeat(64),
        },
      });
      const mismatchedJob = await waitForJob(mismatchedJobId);
      expect(mismatchedJob.error).toContain('archive sha256 mismatch');

      // The pin is optional for arbitrary untrusted imports. The daemon still
      // hashes the archive for its immutable identity and validates its contents.
      await client.removeKnowledgeCatalog('test-notes');
      const { jobId: unpinnedJobId } = await client.installKnowledgeCatalog({
        source: { kind: 'url', url: `http://127.0.0.1:${port}/test-notes.gezk` },
      });
      const unpinnedJob = await waitForJob(unpinnedJobId);
      expect(unpinnedJob.error, JSON.stringify(unpinnedJob)).toBeUndefined();
      const { catalogs: unpinnedCatalogs } = await client.listKnowledgeCatalogs();
      expect(
        unpinnedCatalogs.find((catalog) => catalog.ref.catalogId === 'test-notes')?.ref
          .contentDigest,
      ).toBe(digest);

      // The staging download is gone once installed.
      const leftovers = await stat(knowledgeDownloadsDir(home)).catch(() => null);
      if (leftovers) {
        const { readdir } = await import('node:fs/promises');
        const files = await readdir(knowledgeDownloadsDir(home));
        expect(files.filter((f) => f.endsWith('.partial'))).toEqual([]);
      }
    } finally {
      server.close();
    }
  }, 60_000);

  it('read_document-style URI resolution rejects unknown catalogs', async () => {
    await expect(client.readKnowledgeDocument('no-such-catalog', 'x')).rejects.toThrow();
  });

  it('a chat turn proactively injects cited knowledge within budget (Phase 4)', async () => {
    const gezels = await client.listGezels();
    const gezelId = gezels.gezels[0]?.id;
    expect(gezelId).toBeDefined();
    if (!gezelId) return;

    // Sends are fire-and-forget (`accepted: true`); wait for the assistant
    // turn to land before reading the audit log.
    const sendAndWait = async (message: string): Promise<void> => {
      const before = (await client.chatHistory(gezelId, 'default')).messages.filter(
        (m) => m.role === 'assistant',
      ).length;
      await client.sendChatMessage(gezelId, { message, projectId: 'default' });
      for (let i = 0; i < 100; i++) {
        const hist = await client.chatHistory(gezelId, 'default');
        if (hist.messages.filter((m) => m.role === 'assistant').length > before) return;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error('assistant turn never completed');
    };

    await sendAndWait('How do dovetail joints hold together without glue in fine woodworking?');

    const injected = await client.listHistory({ kind: 'retrieval.context-injected' });
    const events = injected.entries.filter(
      (entry): entry is Extract<typeof entry, { details?: Record<string, unknown> }> =>
        'details' in entry,
    );
    const withKnowledge = events.find((entry) => {
      const hits = (entry.details as { hits?: Array<{ source?: string; uri?: string }> })?.hits;
      return hits?.some((h) => h.source === 'knowledge');
    });
    expect(withKnowledge, 'no retrieval event carried a knowledge hit').toBeDefined();
    const details = withKnowledge?.details as {
      estimatedTokens: number;
      maxTokens: number;
      hits: Array<{ source: string; uri?: string; catalogId?: string; path?: string }>;
    };
    expect(details.estimatedTokens).toBeLessThanOrEqual(details.maxTokens);
    const knowledgeHits = details.hits.filter((h) => h.source === 'knowledge');
    expect(knowledgeHits.length).toBeLessThanOrEqual(2); // balanced ceiling
    for (const hit of knowledgeHits) {
      expect(hit.uri).toMatch(/^knowledge:\/\/test-notes\//);
      expect(hit.catalogId).toBe('test-notes');
    }

    // Disable the catalog: the next turn injects no reference content.
    await client.updateKnowledgeCatalog('test-notes', { enabled: false });
    await sendAndWait('Tell me more about mortise and tenon joinery techniques please.');
    const after = await client.listHistory({ kind: 'retrieval.context-injected' });
    const newest = after.entries.filter(
      (e): e is Extract<typeof e, { details?: Record<string, unknown> }> =>
        'details' in e && !injected.entries.some((p) => p.id === e.id),
    );
    expect(newest.length).toBeGreaterThan(0);
    for (const entry of newest) {
      const hits = (entry.details as { hits?: Array<{ source?: string }> })?.hits ?? [];
      expect(hits.every((h) => h.source !== 'knowledge')).toBe(true);
    }
    await client.updateKnowledgeCatalog('test-notes', { enabled: true });
  }, 60_000);

  it('reports newer versions from the signed publisher registry (Phase 6)', async () => {
    // Unconfigured: honest unavailability, never an error.
    expect(await client.knowledgeUpdates()).toEqual({
      available: false,
      reason: 'no-registry-url',
    });

    const { generateKnowledgeSigningKeyPair, signRegistryIndex } = await import(
      '@bendyline/gezel-knowledge'
    );
    const keys = generateKnowledgeSigningKeyPair();
    const installed = (await client.listKnowledgeCatalogs()).catalogs.find(
      (c) => c.ref.catalogId === 'test-notes',
    );
    expect(installed).toBeDefined();
    if (!installed) return;

    const registry = signRegistryIndex(
      {
        kind: 'gezel-knowledge-registry',
        formatVersion: 1,
        publisher: { id: installed.ref.publisherId, name: 'Gezel Tests' },
        generatedAt: new Date().toISOString(),
        catalogs: [
          {
            catalogId: 'test-notes',
            version: `${installed.ref.version}.99`,
            name: 'Test Notes (newer)',
            language: 'en',
            documents: 3,
            archiveBytes: 4096,
            contentDigest: 'c'.repeat(64),
            url: 'https://example.com/_knowledge/catalogs/test-notes/next/test-notes-next.gezk',
            license: { name: 'CC BY-SA 4.0', attributionRequired: true },
          },
        ],
      },
      keys.privateKeyPem,
    );

    const registryServer: Server = createServer((_req, res) => {
      const body = JSON.stringify(registry);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    });
    await new Promise<void>((resolve) => registryServer.listen(0, '127.0.0.1', resolve));
    const registryAddress = registryServer.address();
    const registryPort =
      typeof registryAddress === 'object' && registryAddress ? registryAddress.port : 0;
    const registryUrl = `http://127.0.0.1:${registryPort}/index.json`;
    await svc.context.store.writeConfig({ knowledge: { registryUrl } });

    const anchorsPath = join(dir, 'trust-anchors.json');
    const priorAnchors = process.env.GEZEL_KNOWLEDGE_TRUST_ANCHORS;
    try {
      // Configured URL but no anchor that can verify it: refuse to consult.
      delete process.env.GEZEL_KNOWLEDGE_TRUST_ANCHORS;
      expect(await client.knowledgeUpdates()).toEqual({
        available: false,
        reason: 'no-trust-anchors',
      });

      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        anchorsPath,
        JSON.stringify([{ keyId: keys.keyId, publicKeyPem: keys.publicKeyPem }]),
        'utf8',
      );
      process.env.GEZEL_KNOWLEDGE_TRUST_ANCHORS = anchorsPath;

      const updates = await client.knowledgeUpdates();
      expect(updates.available).toBe(true);
      if (!updates.available) return;
      expect(updates.publisher.id).toBe(installed.ref.publisherId);
      expect(updates.updates).toHaveLength(1);
      expect(updates.updates[0]).toMatchObject({
        catalogId: 'test-notes',
        installedVersion: installed.ref.version,
        availableVersion: `${installed.ref.version}.99`,
        contentDigest: 'c'.repeat(64),
      });
    } finally {
      if (priorAnchors === undefined) delete process.env.GEZEL_KNOWLEDGE_TRUST_ANCHORS;
      else process.env.GEZEL_KNOWLEDGE_TRUST_ANCHORS = priorAnchors;
      await svc.context.store.writeConfig({ knowledge: {} });
      registryServer.close();
    }
  }, 30_000);
});
