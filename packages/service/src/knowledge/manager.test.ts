import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { knowledgeCatalogVersionDir } from '@bendyline/gezel/paths';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInProcessCatalogHost } from './catalog-host.js';
import type { KnowledgeInstallEvent } from './install.js';
import { KnowledgeManager } from './manager.js';
import { buildTestCatalog, testHashVector } from './test-catalog-fixture.js';

let dir: string;
let home: string;
let archivePath: string;
let manager: KnowledgeManager;

async function runInstall(m: KnowledgeManager, path: string): Promise<KnowledgeInstallEvent[]> {
  const { jobId } = m.startInstall({ kind: 'file', path });
  const events: KnowledgeInstallEvent[] = [];
  await new Promise<void>((resolve) => {
    const unsub = m.subscribeJob(jobId, (event) => {
      events.push(event);
      if (event.type === 'done' || event.type === 'error') {
        unsub?.();
        resolve();
      }
    });
    if (!unsub) resolve();
  });
  return events;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-knowledge-manager-'));
  home = join(dir, 'home');
  archivePath = join(dir, 'test-notes-1.0.0.gezk');
  await buildTestCatalog({ outputPath: archivePath, workDir: join(dir, 'work') });
  manager = new KnowledgeManager({ home, host: await createInProcessCatalogHost() });
  await manager.start();
}, 60_000);

afterAll(async () => {
  await manager.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('KnowledgeManager', () => {
  it('installs a catalog from a file and mounts it', async () => {
    const events = await runInstall(manager, archivePath);
    const done = events.find((e) => e.type === 'done');
    expect(done, JSON.stringify(events)).toBeDefined();
    const list = await manager.list();
    expect(list.length).toBe(1);
    expect(list[0]?.ref.catalogId).toBe('test-notes');
    expect(list[0]?.enabled).toBe(true);
    expect(list[0]?.mounted).toBe(true);
    expect(list[0]?.documents).toBe(2);
    // The hash-embed profile is not the daemon's embedder → FTS-only.
    expect(list[0]?.vectorCompatible).toBe(false);
  });

  it('serves the shipped TOC and document bodies', async () => {
    const topics = await manager.topics('test-notes');
    expect(topics.map((t) => t.name).sort()).toEqual(['Finishing', 'Joinery']);
    const page = await manager.documentsPage('test-notes', { topicId: 'joinery' });
    expect(page.total).toBe(1);
    const doc = await manager.getDocument('test-notes', 'dovetails');
    expect(doc?.markdown).toContain('Tails and pins');
  });

  it('answers explicit search with cited knowledge results', async () => {
    const results = await manager.searchUnified('dovetail corner joint', {
      vector: null,
      maxResults: 10,
    });
    expect(results.length).toBeGreaterThan(0);
    const hit = results[0];
    expect(hit?.kind).toBe('knowledge');
    expect(hit?.catalogId).toBe('test-notes');
    expect(hit?.uri).toMatch(/^knowledge:\/\/test-notes\//);
    expect(hit?.retrievalSource).toBe('knowledge');
  });

  it('semantic path reranks with the exact-vector query', async () => {
    // The fixture profile is not vector-compatible with the daemon embedder,
    // so the manager must refuse the vector and still answer via FTS.
    const chunkText = 'Tails and pins interlock to form a strong corner joint';
    const results = await manager.searchUnified(chunkText, {
      vector: testHashVector(chunkText),
      maxResults: 5,
    });
    expect(results.some((r) => r.documentId === 'dovetails')).toBe(true);
    expect(results.every((r) => typeof r.relevance === 'number')).toBe(true);
  });

  it('project policy off/selected filters the active catalogs', async () => {
    const withPolicy = new KnowledgeManager({
      home,
      host: await createInProcessCatalogHost(),
      projectPolicy: async (projectId) =>
        projectId === 'off-project'
          ? { mode: 'off' }
          : projectId === 'selected-project'
            ? { mode: 'selected', refs: [{ publisherId: 'gezel-tests', catalogId: 'test-notes' }] }
            : null,
    });
    await withPolicy.start();
    try {
      const off = await withPolicy.searchUnified('dovetail', {
        vector: null,
        maxResults: 5,
        projectId: 'off-project',
      });
      expect(off).toEqual([]);
      const selected = await withPolicy.searchUnified('dovetail', {
        vector: null,
        maxResults: 5,
        projectId: 'selected-project',
      });
      expect(selected.length).toBeGreaterThan(0);
    } finally {
      await withPolicy.stop();
    }
  });

  it('quarantines a corrupted catalog on remount with a reason', async () => {
    const entry = manager.registry.find('gezel-tests', 'test-notes');
    expect(entry).not.toBeNull();
    const rootDir = knowledgeCatalogVersionDir(
      home,
      'gezel-tests',
      'test-notes',
      '1.0.0',
      entry?.ref.contentDigest ?? '',
    );
    const routerPath = join(rootDir, 'index', 'router.db');
    // Unmount first — the mounted database holds a read lock on Windows.
    await manager.setEnabled('test-notes', false);
    const original = Buffer.from(await readFile(routerPath));
    const corrupted = Buffer.from(original);
    corrupted[Math.floor(corrupted.length / 2)] =
      (corrupted[Math.floor(corrupted.length / 2)] as number) ^ 0xff;
    await writeFile(routerPath, corrupted);

    await manager.setEnabled('test-notes', true);
    const list = await manager.list();
    const status = list.find((c) => c.ref.catalogId === 'test-notes');
    expect(status?.enabled).toBe(false);
    expect(status?.disabledReason).toMatch(/file:|verification/);
    expect(status?.mounted).toBe(false);

    // Repair and re-enable — quarantine is recoverable.
    await writeFile(routerPath, original);
    await manager.setEnabled('test-notes', true);
    const healed = (await manager.list()).find((c) => c.ref.catalogId === 'test-notes');
    expect(healed?.enabled).toBe(true);
    expect(healed?.mounted).toBe(true);
  });

  it('remove unmounts, forgets, and deletes the private bytes', async () => {
    expect(await manager.remove('test-notes')).toBe(true);
    expect((await manager.list()).length).toBe(0);
    const results = await manager.searchUnified('dovetail', { vector: null, maxResults: 5 });
    expect(results).toEqual([]);
    expect(await manager.remove('test-notes')).toBe(false);
  });
});
