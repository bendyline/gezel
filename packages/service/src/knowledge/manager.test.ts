import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { knowledgeCatalogVersionDir } from '@bendyline/gezel/paths';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInProcessCatalogHost } from './catalog-host.js';
import type { KnowledgeInstallEvent } from './install.js';
import { KnowledgeManager, KnowledgeNotFoundError } from './manager.js';
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
    expect(hit?.uri).toMatch(/^knowledge:\/\/gezel-tests\/test-notes\//);
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

describe('KnowledgeManager — per-profile query embedding', () => {
  let profileDir: string;
  let profileHome: string;
  let profileManager: KnowledgeManager;
  const embedded: string[] = [];

  beforeAll(async () => {
    profileDir = await mkdtemp(join(tmpdir(), 'gezel-knowledge-profile-'));
    profileHome = join(profileDir, 'home');
    const { MULTILINGUAL_E5_SMALL_1 } = await import('@bendyline/gezel-knowledge');
    const archive = join(profileDir, 'e5-notes-1.0.0.gezk');
    await buildTestCatalog({
      outputPath: archive,
      workDir: join(profileDir, 'work'),
      id: 'e5-notes',
      embeddingProfile: MULTILINGUAL_E5_SMALL_1,
    });
    profileManager = new KnowledgeManager({
      home: profileHome,
      host: await createInProcessCatalogHost(),
      embedQueryForProfile: async (text, profile) => {
        embedded.push(`${profile.id}:${text}`);
        return testHashVector(text);
      },
    });
    await profileManager.start();
    await runInstall(profileManager, archive);
  }, 60_000);

  afterAll(async () => {
    await profileManager?.stop();
    await rm(profileDir, { recursive: true, force: true });
  });

  it('mounts a registered foreign profile in profile mode, not keyword-only', async () => {
    const status = (await profileManager.list()).find((c) => c.ref.catalogId === 'e5-notes');
    expect(status?.mounted).toBe(true);
    expect(status?.semanticSearch).toBe('profile');
    expect(status?.vectorCompatible).toBe(true);
  });

  it('embeds the query with the catalog profile and reaches the vector path', async () => {
    // The hash embedder gives the exact stored vector back for the exact
    // embed input the compiler built: passage prefix + title header + text.
    // Read the stored chunk through the host to rebuild that input verbatim.
    const stored = (
      await profileManager.host.search({
        query: 'dovetail',
        shardBudget: 6,
        finalK: 24,
        includeChunkFts: true,
        catalogKeys: ['gezel-tests/e5-notes'],
      })
    ).chunks.find((hit) => hit.documentId === 'dovetails');
    expect(stored).toBeDefined();
    if (!stored) return;
    const path = stored.headingPath.filter((h) => h !== stored.title);
    const header = path.length > 0 ? `${stored.title}\n${path.join(' > ')}\n` : `${stored.title}\n`;
    const embedInput = `passage: ${header}${stored.text}`;
    const results = await profileManager.searchUnified(embedInput, {
      vector: null,
      maxResults: 5,
    });
    expect(embedded.some((e) => e.startsWith('multilingual-e5-small@1:'))).toBe(true);
    const dovetails = results.find((r) => r.documentId === 'dovetails');
    expect(dovetails).toBeDefined();
    expect(dovetails?.relevance).toBe(1);
  });
});

describe('KnowledgeManager with a registered profile id whose pins differ', () => {
  let pinDir: string;
  let pinManager: KnowledgeManager;
  const embedded: string[] = [];

  beforeAll(async () => {
    pinDir = await mkdtemp(join(tmpdir(), 'gezel-knowledge-pin-'));
    const { MULTILINGUAL_E5_SMALL_1 } = await import('@bendyline/gezel-knowledge');
    // Same id, same repo and revision — but produced from the fp16 graph. A
    // reader that matched on id alone would search it with fp32 vectors.
    const archive = join(pinDir, 'e5-fp16-notes-1.0.0.gezk');
    await buildTestCatalog({
      outputPath: archive,
      workDir: join(pinDir, 'work'),
      id: 'e5-fp16-notes',
      embeddingProfile: {
        ...MULTILINGUAL_E5_SMALL_1,
        model: {
          ...MULTILINGUAL_E5_SMALL_1.model,
          onnxFile: 'onnx/model_fp16.onnx',
          onnxDigest: `sha256:${'f'.repeat(64)}`,
        },
      },
    });
    pinManager = new KnowledgeManager({
      home: join(pinDir, 'home'),
      host: await createInProcessCatalogHost(),
      embedQueryForProfile: async (text, profile) => {
        embedded.push(`${profile.id}:${text}`);
        return testHashVector(text);
      },
    });
    await pinManager.start();
    await runInstall(pinManager, archive);
  }, 60_000);

  afterAll(async () => {
    await pinManager?.stop();
    await rm(pinDir, { recursive: true, force: true });
  });

  it('mounts keyword-only and never embeds a query for it', async () => {
    const status = (await pinManager.list()).find((c) => c.ref.catalogId === 'e5-fp16-notes');
    expect(status?.mounted).toBe(true);
    expect(status?.semanticSearch).toBe('keyword-only');
    expect(status?.vectorCompatible).toBe(false);
    const results = await pinManager.searchUnified('dovetail', { vector: null, maxResults: 5 });
    expect(embedded).toEqual([]);
    expect(results.some((r) => r.documentId === 'dovetails')).toBe(true);
  });
});

describe('KnowledgeManager asset access', () => {
  beforeAll(async () => {
    // The first describe removed the catalog; mount it again for this one.
    await runInstall(manager, archivePath);
  });

  it('refuses assets of catalogs that are not mounted', async () => {
    await expect(manager.readAsset('nope', 'assets/mark.png')).rejects.toBeInstanceOf(
      KnowledgeNotFoundError,
    );
    await expect(manager.assets('nope')).rejects.toBeInstanceOf(KnowledgeNotFoundError);
  });

  it('reports no assets for a catalog that ships none', async () => {
    expect(await manager.assets('test-notes')).toEqual([]);
    expect(await manager.readAsset('test-notes', 'assets/mark.png')).toBeNull();
  });
});
