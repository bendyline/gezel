// The HTML converter's cold import can take seconds; collection pays for it.
import '@bendyline/squisq-formats';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type GezelConfig,
  type PromptConnectorRule,
  SECURITY_PRESETS,
  WEB_PAGE_RULE,
} from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConnectorManager } from '../connectors/manager.js';
import { WebsiteService } from '../connectors/natives/website-service.js';
import { registerWebsiteAdapters } from '../connectors/natives/website.js';
import { FakeSite } from '../connectors/testing/fake-site.js';
import { memorySecrets } from '../connectors/testing/harness.js';
import type { Store } from '../fs/store.js';
import { FakePageCapturer } from '../page-capture/fake-capturer.js';
import { PromptConnectorService, namedItemBudgetChars } from './service.js';
import { webPageResolver } from './web-page-resolver.js';

registerWebsiteAdapters();

const MANIFEST = {
  schemaVersion: 1 as const,
  kind: 'connector-type' as const,
  id: 'website',
  name: 'Websites',
  description: '',
  tags: ['web', 'pages'],
  maintainer: { name: 'x' },
  logo: 'logo.webp',
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
  ws = await mkdtemp(join(tmpdir(), 'gezel-prompt-connectors-'));
  await mkdir(join(ws, 'artifacts'), { recursive: true });
  await mkdir(join(ws, 'private', 'quarantine'), { recursive: true });
  await mkdir(join(ws, 'workspace'), { recursive: true });
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

function world(
  opts: {
    catalogHasWebsite?: boolean;
    level?: keyof typeof SECURITY_PRESETS;
    rules?: readonly PromptConnectorRule[];
  } = {},
) {
  const site = new FakeSite();
  site.set('/platform', {
    title: 'The Gezel platform',
    text: [
      'Gezel runs on your own computer and keeps everything in plain files.',
      'Crews of gezels work on projects, and the Meester is the front door.',
    ],
  });
  site.set('/broken', { title: 'Broken', text: [], status: 500 });
  let project = { id: 'p1', connectors: [] as Record<string, unknown>[] };
  const level = opts.level ?? 'lockdown';
  const config = {
    securityPolicy: { level, ...SECURITY_PRESETS[level] },
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
      opts.catalogHasWebsite === false
        ? null
        : {
            manifest: MANIFEST,
            sourceId: 'bundled',
            logoUrl: '/api/catalog/connector-type/website/file/logo.webp?source=bundled',
          },
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
  const service = new PromptConnectorService({
    store,
    catalog,
    resolvers: [webPageResolver({ websites, store })],
    ...(opts.rules ? { rules: opts.rules } : {}),
  });
  return { site, service, websites, project: () => project as never };
}

const ASK = 'Can you summarize https://site.test/platform for me?';

describe('PromptConnectorService', () => {
  it('offers an address with no saved copy, with the connector’s name and artwork', async () => {
    const w = world();
    expect(await w.service.offers(w.project(), ASK)).toEqual([
      {
        rule: 'web-page',
        connectorType: 'website',
        effect: 'include',
        subject: 'https://site.test/platform',
        label: 'site.test/platform',
        typeName: 'Websites',
        typeTags: ['web', 'pages'],
        logoUrl: '/api/catalog/connector-type/website/file/logo.webp?source=bundled',
      },
    ]);
    expect(await w.service.offers(w.project(), 'What is for dinner?')).toEqual([]);
    // Finding offers never reaches the site.
    expect(w.site.served).toEqual([]);
  });

  it('offers nothing where it could not deliver', async () => {
    expect(
      await world({ catalogHasWebsite: false }).service.offers({ id: 'p1' } as never, ASK),
    ).toEqual([]);
    const locked = world({ level: 'super-lockdown' });
    expect(await locked.service.offers(locked.project(), ASK)).toEqual([]);
  });

  it('saves the page when the offer is taken, and stops offering it', async () => {
    const w = world();
    const inclusion = await w.service.accept(w.project(), 'web-page', 'https://site.test/platform');
    expect(inclusion).toMatchObject({
      connectorType: 'website',
      subject: 'https://site.test/platform',
      label: 'site.test/platform',
      title: 'The Gezel platform',
    });
    expect(inclusion.path).toMatch(/\.md$/);
    // The fake site's own description; a real synopsis replaces it once the index writes one.
    expect(inclusion.summary).toBe('About The Gezel platform');
    expect(await w.service.offers(w.project(), ASK)).toEqual([]);
  });

  it('refuses a subject its rule does not claim', async () => {
    const w = world();
    await expect(w.service.accept(w.project(), 'web-page', 'file:///etc/passwd')).rejects.toThrow(
      /nothing to save/,
    );
    await expect(w.service.accept(w.project(), 'nope', 'https://site.test/')).rejects.toThrow(
      /nothing to save/,
    );
    expect(w.site.served).toEqual([]);
  });

  it('gives a turn the saved page: summary, text, and where the copy is', async () => {
    const w = world();
    expect(await w.service.turnContext(w.project(), ASK, {})).toBeNull();
    const saved = await w.service.accept(w.project(), 'web-page', 'https://site.test/platform');
    const calls = w.site.http.calls.length;

    const cited: string[] = [];
    const turn = await w.service.turnContext(w.project(), ASK, {
      toolNames: new Set(['read_artifact']),
      cite: (text) => cited.push(text),
    });
    expect(turn?.inclusions).toEqual([saved]);
    const prompt = turn?.prompt ?? '';
    expect(prompt).toContain('untrusted evidence');
    expect(prompt).toContain('[1] Page: The Gezel platform');
    expect(prompt).toContain('Address: https://site.test/platform');
    expect(prompt).toContain(`Saved copy: ${saved.path} in this project's artifacts`);
    expect(prompt).toContain('read_artifact with this path returns all of it');
    expect(prompt).not.toContain('read_web_page');
    expect(prompt).toContain('keeps everything in plain files');
    expect(prompt).not.toContain('How the page looked');
    expect(cited[0]).toContain('keeps everything in plain files');
    // Reading the copy for a turn never reaches the site.
    expect(w.site.http.calls.length).toBe(calls);

    const bare = await w.service.turnContext(w.project(), ASK, {});
    expect(bare?.prompt).not.toMatch(/read_artifact|read_web_page/);
    expect(bare?.prompt).toContain('Page: The Gezel platform');
  });

  it('tells the turn when a named page could not be saved', async () => {
    const w = world();
    const failed = await w.service.accept(w.project(), 'web-page', 'https://site.test/broken');
    expect(failed.path).toBeUndefined();
    expect(failed.reason).toBeTruthy();
    const turn = await w.service.turnContext(
      w.project(),
      'What does site.test/broken say? https://site.test/broken',
      {},
    );
    expect(turn?.inclusions[0]).toMatchObject({ subject: 'https://site.test/broken' });
    expect(turn?.inclusions[0]?.path).toBeUndefined();
    expect(turn?.prompt).toContain('No saved copy:');
    expect(turn?.prompt).toContain('Do not guess what it says');
  });

  it('runs a rule added before the page rule through its own resolver', async () => {
    const repoRule: PromptConnectorRule = {
      id: 'github-repo',
      connectorType: 'website',
      effect: 'connect',
      find: ({ urls }) =>
        urls
          .filter((url) => new URL(url).hostname === 'github.com')
          .map((url) => ({ subject: url, label: new URL(url).pathname.slice(1) })),
    };
    const w = world();
    const service = new PromptConnectorService({
      store: {
        readConfig: async () => ({
          securityPolicy: { level: 'lockdown', ...SECURITY_PRESETS.lockdown },
        }),
      } as never,
      catalog: { get: async () => ({ manifest: MANIFEST, sourceId: 'bundled' }) } as never,
      rules: [repoRule, WEB_PAGE_RULE],
      resolvers: [
        { rule: 'github-repo', open: async (_project, candidates) => [...candidates] },
        webPageResolver({
          websites: w.websites,
          store: { projectArtifactsDir: () => join(ws, 'artifacts') } as never,
        }),
      ],
    });
    const offers = await service.offers(
      w.project(),
      'Compare https://github.com/bendyline/gezel with https://site.test/platform',
    );
    expect(offers.map((o) => [o.rule, o.effect, o.label])).toEqual([
      ['github-repo', 'connect', 'bendyline/gezel'],
      ['web-page', 'include', 'site.test/platform'],
    ]);
    // A connect offer opens a form; there is nothing for Send to take.
    await expect(
      service.accept(w.project(), 'github-repo', 'https://github.com/bendyline/gezel'),
    ).rejects.toThrow(/nothing to save/);
  });
});

describe('namedItemBudgetChars', () => {
  it('scales with the model’s window and stops at a ceiling', () => {
    expect(namedItemBudgetChars(8_192)).toBe(320 * 3 * 4);
    expect(namedItemBudgetChars(32_768)).toBe(1_400 * 3 * 4);
    expect(namedItemBudgetChars(200_000)).toBe(6_000 * 4);
    expect(namedItemBudgetChars(undefined)).toBe(6_000 * 4);
  });
});
