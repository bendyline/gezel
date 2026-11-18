import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { securityPolicyForLevel } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ConnectorManager } from './manager.js';
import { registerRssFeedAdapters } from './natives/rss-feed.js';
import { registerXAdapters } from './natives/x-posts.js';
import { connectorSecretKey } from './registry.js';
import { FakeFeedServer } from './testing/fake-feeds.js';
import { FakeHttp } from './testing/fake-http.js';
import { FakeX } from './testing/fake-x.js';
import { readCorpus } from './testing/harness.js';

const BLOG = 'https://blog.example.test/feed.xml';
const NEWS = 'https://news.example.test/atom.xml';

let home: string | null = null;
afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
  home = null;
});

describe('a settings change that drops a source', () => {
  it('the next pass forgets the dropped scope; a window type keeps its records', async () => {
    registerRssFeedAdapters();
    home = await mkdtemp(join(tmpdir(), 'gezel-patch-'));
    const store = new Store({ home });
    await store.ensureLayout();
    await store.writeConfig({ securityPolicy: securityPolicyForLevel('free') });
    const project = await store.createProject({ name: 'Feeds' });
    const http = new FakeHttp();
    new FakeFeedServer(http)
      .feed(BLOG, {
        format: 'rss',
        items: [{ guid: 'b1', title: 'Blog one', date: '2026-09-01T00:00:00Z' }],
      })
      .feed(NEWS, {
        format: 'atom',
        items: [{ guid: 'n1', title: 'News one', date: '2026-09-01T00:00:00Z' }],
      });
    const connectors = new ConnectorManager({
      store,
      secrets: new FileSecretStore(home),
      catalog: new CatalogService(),
      fetch: http.fetch,
    });
    const binding = await connectors.bind(project, {
      type: 'rss-feed',
      sourceId: 'bundled',
      config: { feeds: [BLOG, NEWS] },
    });
    expect((await connectors.syncBinding(project, binding.id)).error).toBeUndefined();
    const scopesOf = async () => {
      const b = (await store.getProject(project.id))!.connectors!.find((x) => x.id === binding.id)!;
      return { cursor: b.cursor as { scopes: Record<string, unknown>; reconcileScopes?: true }, b };
    };
    expect(Object.keys((await scopesOf()).cursor.scopes)).toHaveLength(2);

    await connectors.patchBinding(project, binding.id, { config: { feeds: [BLOG] } });
    expect((await scopesOf()).cursor.reconcileScopes).toBe(true);

    const r = await connectors.syncBinding(project, binding.id);
    expect(r.error).toBeUndefined();
    const { cursor, b } = await scopesOf();
    expect(Object.keys(cursor.scopes)).toHaveLength(1);
    expect(cursor.reconcileScopes).toBeUndefined();
    const titles = (await readCorpus(store.projectArtifactsDir(project.id), b.corpusDir!)).map(
      (x) => x.frontmatter.title,
    );
    expect(titles.sort()).toEqual(['Blog one', 'News one']);

    // Saving the same settings again is not a change.
    await connectors.patchBinding(project, binding.id, { config: { feeds: [BLOG] } });
    expect((await scopesOf()).cursor.reconcileScopes).toBeUndefined();
  });

  it('re-links in place: a new credential, the same settings, cursor and records', async () => {
    registerRssFeedAdapters();
    home = await mkdtemp(join(tmpdir(), 'gezel-relink-'));
    const store = new Store({ home });
    await store.ensureLayout();
    await store.writeConfig({ securityPolicy: securityPolicyForLevel('free') });
    const project = await store.createProject({ name: 'Relink' });
    const http = new FakeHttp();
    new FakeFeedServer(http).feed(BLOG, {
      format: 'rss',
      items: [{ guid: 'b1', title: 'Blog one', date: '2026-09-01T00:00:00Z' }],
    });
    const secrets = new FileSecretStore(home);
    const connectors = new ConnectorManager({
      store,
      secrets,
      catalog: new CatalogService(),
      fetch: http.fetch,
    });
    const binding = await connectors.bind(project, {
      type: 'rss-feed',
      sourceId: 'bundled',
      config: { feeds: [BLOG] },
      credential: 'old-token',
    });
    await connectors.syncBinding(project, binding.id);
    const before = (await store.getProject(project.id))!.connectors!.find(
      (b) => b.id === binding.id,
    )!;
    await store.updateProject(project.id, {
      connectors: [{ ...before, lastError: 'the token was refused' }],
    });

    const after = await connectors.reconnect(project, binding.id, 'new-token');
    const stored = (await store.getProject(project.id))!.connectors!.find(
      (b) => b.id === binding.id,
    )!;
    expect(after.id).toBe(binding.id);
    expect(stored.lastError).toBeUndefined();
    expect(stored.config).toEqual(before.config);
    expect(stored.cursor).toEqual(before.cursor);
    expect(await secrets.get(connectorSecretKey('rss-feed', binding.id))).toBe('new-token');
    const titles = (await readCorpus(store.projectArtifactsDir(project.id), stored.corpusDir!)).map(
      (x) => x.frontmatter.title,
    );
    expect(titles).toEqual(['Blog one']);
  });

  it('checks a connection with a trial pass that changes nothing the project keeps', async () => {
    registerXAdapters();
    home = await mkdtemp(join(tmpdir(), 'gezel-check-'));
    const store = new Store({ home });
    await store.ensureLayout();
    await store.writeConfig({ securityPolicy: securityPolicyForLevel('free') });
    const project = await store.createProject({ name: 'Check' });
    const fake = new FakeX({ now: new Date() });
    fake.addPost('A post nobody else should read');
    const connectors = new ConnectorManager({
      store,
      secrets: new FileSecretStore(home),
      catalog: new CatalogService(),
      fetch: fake.http.fetch,
    });
    const binding = await connectors.bind(project, {
      type: 'x-posts',
      sourceId: 'bundled',
      config: { metricsHistory: false },
      credential: JSON.stringify(fake.credential()),
    });

    const check = await connectors.checkConnection(project, binding.id, { cassette: true });
    expect(check.ok).toBe(true);
    expect(check.records).toBeGreaterThan(0);
    expect(check.requests).toContainEqual({
      method: 'GET',
      endpoint: 'https://api.x.com/2/users/me',
      status: 200,
    });
    expect(JSON.stringify(check.cassette)).not.toContain('nobody else should read');

    const after = (await store.getProject(project.id))!.connectors!.find(
      (b) => b.id === binding.id,
    )!;
    expect(after.cursor).toBeUndefined();
    expect(after.lastSyncedAt).toBeUndefined();
    expect(await readCorpus(store.projectArtifactsDir(project.id), after.corpusDir!)).toEqual([]);

    const plain = await connectors.checkConnection(project, binding.id);
    expect(plain.cassette).toBeUndefined();
  });
});
