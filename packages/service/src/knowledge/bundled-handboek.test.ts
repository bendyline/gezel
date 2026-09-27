import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CatalogService } from '@bendyline/gezel-catalog';
import { describe, expect, it } from 'vitest';
import {
  createHandboekEngine,
  findHandboekContent,
  handboekKnowledgeFingerprint,
  handboekKnowledgeSource,
  siteDeviceInfo,
} from '../handboek/engine.js';
import { createInProcessCatalogHost } from './catalog-host.js';
import { KnowledgeManager } from './manager.js';

const archive = resolve(import.meta.dirname, '..', '..', 'assets', 'handboek', 'handboek.gezk');

describe('bundled Handboek knowledge catalog', () => {
  it('matches the current documentation source', async () => {
    const contentDir = findHandboekContent();
    expect(contentDir).toBeTruthy();
    const engine = createHandboekEngine({
      catalog: new CatalogService(),
      device: siteDeviceInfo,
      contentDir: contentDir!,
    });
    const source = await handboekKnowledgeSource(engine, contentDir!);
    const lock = await readFile(
      resolve(import.meta.dirname, '..', '..', 'assets', 'handboek', 'handboek-source.sha256'),
      'utf8',
    );
    expect(handboekKnowledgeFingerprint(source)).toBe(lock.trim());
    const pkg = JSON.parse(
      await readFile(resolve(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { version: string };
    const { readGezkManifest } = await import('@bendyline/gezel-knowledge');
    expect((await readGezkManifest(archive)).version).toBe(pkg.version);
  }, 30_000);

  it('installs, browses, retrieves, and preserves a disabled choice', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gezel-handboek-gezk-'));
    let manager = new KnowledgeManager({
      home,
      host: await createInProcessCatalogHost(),
      bundledHandboekArchive: archive,
    });
    try {
      await manager.start();
      const status = (await manager.list()).find((item) => item.ref.catalogId === 'handboek');
      expect(status?.source).toBe('bundled');
      expect(status?.mounted).toBe(true);
      expect(status?.documents).toBeGreaterThan(300);
      expect(status?.vectorCompatible).toBe(true);

      const article = await manager.getDocument('handboek', 'welcome');
      expect(article?.markdown).toContain('assets/gezel-mark.png');
      expect(article?.markdown).toContain('knowledge://bendyline/handboek/the-crew');
      const image = await manager.readAsset('handboek', 'assets/gezel-mark.png');
      expect(image?.bytes.length).toBeGreaterThan(0);
      const results = await manager.searchUnified('How do I create a project?', {
        vector: null,
        maxResults: 10,
        queryEmbedBudgetMs: 0,
      });
      expect(results.some((hit) => hit.catalogId === 'handboek')).toBe(true);
      expect(results.some((hit) => hit.uri?.startsWith('knowledge://bendyline/handboek/'))).toBe(
        true,
      );

      expect(await manager.setEnabled('handboek', false)).toBe(true);
      expect(await manager.remove('handboek')).toBe(false);
      await manager.stop();
      manager = new KnowledgeManager({
        home,
        host: await createInProcessCatalogHost(),
        bundledHandboekArchive: archive,
      });
      await manager.start();
      const disabled = (await manager.list()).find((item) => item.ref.catalogId === 'handboek');
      expect(disabled?.enabled).toBe(false);
      expect(disabled?.mounted).toBe(false);
    } finally {
      await manager.stop();
      await rm(home, { recursive: true, force: true });
    }
  }, 120_000);
});
