// The HTML converter's cold import can take seconds; collection pays for it.
import '@bendyline/squisq-formats';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type GezelConfig, SECURITY_PRESETS } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../fs/store.js';
import { FakePageCapturer } from '../../page-capture/fake-capturer.js';
import { ConnectorManager } from '../manager.js';
import { FakeSite } from '../testing/fake-site.js';
import { memorySecrets } from '../testing/harness.js';
import { WebsiteService } from './website-service.js';
import { registerWebsiteAdapters } from './website.js';

registerWebsiteAdapters();

const MANIFEST = {
  schemaVersion: 1 as const,
  kind: 'connector-type' as const,
  id: 'website',
  name: 'Websites',
  description: '',
  tags: [],
  maintainer: { name: 'x' },
  version: '1.0.0',
  releasedAt: '2026-11-16T00:00:00Z',
  driver: 'native' as const,
  source: { adapterId: 'website' },
  normalize: { kind: 'native' as const },
  actions: [],
  completeness: 'window' as const,
  availableVersions: ['1.0.0'],
};

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'gezel-website-svc-'));
  // Production creates these before a pass; the writer's containment check needs them.
  await mkdir(join(ws, 'artifacts'), { recursive: true });
  await mkdir(join(ws, 'private', 'quarantine'), { recursive: true });
  await mkdir(join(ws, 'workspace'), { recursive: true });
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

function world(opts: { catalogHasWebsite?: boolean } = {}) {
  const site = new FakeSite();
  site.set('/', {
    title: 'Docs home',
    text: ['The home page of the fake documentation site.'],
    links: ['/guide'],
  });
  site.set('/guide', {
    title: 'Guide',
    text: ['The guide explains everything step by step.'],
    links: ['/guide/deep'],
  });
  site.set('/guide/deep', { title: 'Deep', text: ['A page two links away from the start.'] });
  new FakeSite('https://other.test', site.http).set('/article', {
    title: 'Article',
    text: ['An article somewhere else entirely.'],
  });
  let project = { id: 'p1', connectors: [] as Record<string, unknown>[] };
  const config = {
    securityPolicy: { level: 'lockdown', ...SECURITY_PRESETS.lockdown },
  } as unknown as GezelConfig;
  const store = {
    getProject: async () => project,
    updateProject: async (_id: string, patch: Partial<typeof project>) => {
      project = { ...project, ...patch };
      return project;
    },
    readConfig: async () => config,
    homePath: join(ws, 'home'),
    projectWorkspaceDir: async () => join(ws, 'workspace'),
    projectArtifactsDir: () => join(ws, 'artifacts'),
    projectQuarantineDir: () => join(ws, 'private', 'quarantine'),
    get historyManager() {
      return undefined;
    },
  } as unknown as Store;
  const { secrets } = memorySecrets();
  const catalog = {
    get: async () =>
      opts.catalogHasWebsite === false ? null : { manifest: MANIFEST, sourceId: 'bundled' },
  } as unknown as ConstructorParameters<typeof ConnectorManager>[0]['catalog'];
  const capturer = new FakePageCapturer(site.http.fetch);
  const connectors = new ConnectorManager({
    store,
    secrets,
    catalog,
    capturer,
    fetch: site.http.fetch,
  });
  const websites = new WebsiteService({ store, connectors, secrets, capturer });
  return { site, store, connectors, websites, capturer, project: () => project as never };
}

describe('WebsiteService', () => {
  it('fetches a gezel’s request only for a link the crawler already found', async () => {
    const w = world();
    const binding = await w.connectors.bind(w.project(), {
      type: 'website',
      config: { sites: ['https://site.test/'], followLinks: 1 },
    });
    for (let i = 0; i < 2; i++) {
      const r = await w.connectors.syncBinding(w.project(), binding.id);
      expect(r.error).toBeUndefined();
    }
    expect(w.site.served).not.toContain('/guide/deep');

    // Found as a link, beyond the depth: fetched on request.
    const found = await w.websites.requestPage(w.project(), 'https://site.test/guide/deep');
    expect(found.status).toBe('saved');
    expect(w.site.served).toContain('/guide/deep');

    // Composed by the model: never fetched.
    const before = w.site.http.calls.length;
    const composed = await w.websites.requestPage(
      w.project(),
      'https://other.test/article?q=secret-data',
    );
    expect(composed.status).toBe('needs-permission');
    const sameSite = await w.websites.requestPage(w.project(), 'https://site.test/never-linked');
    expect(sameSite.status).toBe('needs-permission');
    expect(w.site.http.calls.length).toBe(before);
  });

  it('asks the person when the connection says so', async () => {
    const w = world();
    const binding = await w.connectors.bind(w.project(), {
      type: 'website',
      config: { sites: ['https://site.test/'], followLinks: 0, gezelRequests: 'ask' },
    });
    await w.connectors.syncBinding(w.project(), binding.id);
    const r = await w.websites.requestPage(w.project(), 'https://site.test/guide');
    expect(r.status).toBe('needs-permission');
  });

  it('saves a page the person pastes into a Saved pages connection that never follows links', async () => {
    const w = world();
    const saved = await w.websites.savePage(w.project(), 'other.test/article');
    expect(saved.page.state).toBe('saved');
    expect(saved.page.path).toBeTruthy();
    const binding = (
      w.project() as {
        connectors: { id: string; displayName?: string; config: Record<string, unknown> }[];
      }
    ).connectors[0]!;
    expect(binding.displayName).toBe('Saved pages');
    expect(binding.config).toMatchObject({
      followLinks: 0,
      refreshEveryHours: 0,
      savedPages: true,
    });
    const list = await w.websites.list(w.project());
    // Links on the saved page are known (a gezel may ask for one) but never followed.
    expect(list.pages.filter((p) => p.path).map((p) => p.url)).toEqual([
      'https://other.test/article',
    ]);
    expect(list.pages.filter((p) => !p.path).every((p) => p.state === 'skipped')).toBe(true);
  });

  it('keeps saving pasted pages past the 25 addresses a followed connection allows', async () => {
    const w = world();
    await w.websites.savePage(w.project(), 'other.test/article');
    const binding = (
      w.project() as { connectors: { id: string; config: Record<string, unknown> }[] }
    ).connectors[0]!;
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => `https://page${i}.example.test/`);
    await w.connectors.patchBinding(w.project(), binding.id, {
      config: { ...binding.config, sites: ['https://other.test/article', ...many(24)] },
    });
    const saved = await w.websites.savePage(w.project(), 'https://site.test/guide');
    expect(saved.page.state).toBe('saved');

    await w.connectors.patchBinding(w.project(), binding.id, {
      config: { ...binding.config, sites: many(500) },
    });
    await expect(w.websites.savePage(w.project(), 'https://site.test/guide/deep')).rejects.toThrow(
      /already keeps 500 pages/,
    );
  });

  it('saves a pasted page into the connection that already found it, even past a redirect', async () => {
    const w = world();
    w.site.set('/en/learn/intro', { title: 'old', text: [], redirectTo: '/learn/intro' });
    w.site.set('/learn/intro', {
      title: 'Intro',
      text: ['The introduction to the fake product.'],
      links: ['/learn/next'],
    });
    w.site.set('/learn/next', { title: 'Next', text: ['The page after the introduction.'] });
    const binding = await w.connectors.bind(w.project(), {
      type: 'website',
      config: { sites: ['https://site.test/en/learn/intro'], followLinks: 0 },
    });
    await w.connectors.syncBinding(w.project(), binding.id);
    expect((await w.websites.find(w.project(), 'https://site.test/learn/next'))?.state).toBe(
      'skipped',
    );

    const saved = await w.websites.savePage(w.project(), 'https://site.test/learn/next');
    expect(saved.bindingId).toBe(binding.id);
    expect(saved.page).toMatchObject({ bindingId: binding.id, state: 'saved' });
    expect((w.project() as { connectors: unknown[] }).connectors).toHaveLength(1);
  });

  it('says it cannot save pages when the catalog has no website connection', async () => {
    const w = world({ catalogHasWebsite: false });
    expect((await w.websites.list(w.project())).canSave).toBe(false);
    await expect(w.websites.savePage(w.project(), 'www.microsoft.com')).rejects.toThrow(
      /can't save web pages yet/,
    );
    expect((w.project() as { connectors: unknown[] }).connectors).toHaveLength(0);
    const ready = world();
    expect((await ready.websites.list(ready.project())).canSave).toBe(true);
  });
});
