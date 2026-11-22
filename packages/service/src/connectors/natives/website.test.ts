// The HTML converter's cold import alone can take seconds on a loaded machine;
// loaded here, collection pays for it instead of the first conformance check.
import '@bendyline/squisq-formats';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakePageCapturer } from '../../page-capture/fake-capturer.js';
import { syncWithAdapter } from '../manager.js';
import {
  HOSTILE_NAME,
  INJECTION_PAYLOAD,
  describeConnectorConformance,
} from '../testing/conformance.js';
import { FakeSite } from '../testing/fake-site.js';
import {
  type ConnectorTestEnv,
  assertCorpusInvariants,
  createConnectorTestEnv,
  readCorpus,
} from '../testing/harness.js';
import type { ConnectorBindingRef, NormalizedRecord, SyncTrigger } from '../types.js';
import { crawlPageFor, readCrawlState } from './website-crawl.js';
import { writeSession } from './website-session.js';
import { WebsiteAdapter, parseWebsiteConfig } from './website.js';

// Each pass converts pages to markdown and writes a corpus; in a full local
// service run (27 minutes of parallel workers) the first conformance passes
// went past the default 5 s while CI's ran in well under it.
vi.setConfig({ testTimeout: 30_000 });

const MINUTE = 60_000;
const START = Date.parse('2026-11-10T10:00:00Z');

function seedSite(site: FakeSite): void {
  site.set('/', {
    title: 'Fake Site Home',
    text: ['Welcome to the fake site, which exists so the website connector can be tested.'],
    links: ['/docs/', '/docs/intro', '/blog/post-1'],
  });
  site.set('/docs/', {
    title: 'Documentation',
    text: ['All the documentation for the fake product lives under this folder.'],
    links: ['/docs/intro'],
  });
  site.set('/docs/intro', {
    title: 'Introduction',
    text: ['The introduction explains what the fake product does and who it is for.'],
  });
  site.set('/blog/post-1', {
    title: 'First post',
    text: ['The first post on the fake blog announces the fake product to the world.'],
  });
}

interface World {
  env: ConnectorTestEnv;
  site: FakeSite;
  clock: { now: number };
  config: Record<string, unknown>;
  stateDir: string;
  capturer: FakePageCapturer;
  adapter(trigger?: SyncTrigger): WebsiteAdapter;
}

async function makeWorld(config: Record<string, unknown> = {}): Promise<World> {
  const env = await createConnectorTestEnv();
  const site = new FakeSite();
  seedSite(site);
  const clock = { now: START };
  const stateDir = join(env.root, 'state', 'website-1');
  const capturer = new FakePageCapturer(site.http.fetch);
  const world: World = {
    env,
    site,
    clock,
    config: { sites: ['https://site.test/'], ...config },
    stateDir,
    capturer,
    adapter: (trigger = 'manual') =>
      new WebsiteAdapter(
        binding(world.config),
        env.deps({ capturer, stateDir, fetch: site.http.fetch, trigger }),
        { now: () => clock.now, minHostGapMs: 0 },
      ),
  };
  return world;
}

function binding(config: Record<string, unknown>): ConnectorBindingRef {
  return { id: 'website:test', type: 'website', config };
}

describeConnectorConformance('website', {
  async create() {
    const w = await makeWorld();
    return {
      env: w.env,
      // Four pages, the site overview, and the month's change log.
      seeded: 6,
      requiredKeys: ['kind', 'title', 'site'],
      adapter: async () => w.adapter(),
      unrouted: () => w.site.http.unrouted,
      hooks: {
        update() {
          w.site.set('/docs/intro', {
            title: 'Introduction',
            text: [
              'The introduction explains what the fake product does and who it is for.',
              'A new section now covers installing the fake product on every platform.',
            ],
          });
          w.clock.now += 11 * MINUTE;
        },
        remove() {
          w.site.remove('/blog/post-1');
          w.clock.now += 11 * MINUTE;
        },
        addHostile() {
          w.site.set('/evil', { title: HOSTILE_NAME, text: [INJECTION_PAYLOAD] });
          const home = w.site.get('/')!;
          w.site.set('/', { ...home, links: [...(home.links ?? []), '/evil'] });
          w.clock.now += 11 * MINUTE;
        },
      },
    };
  },
});

describe('website connector', () => {
  let world: World | null = null;
  afterEach(async () => {
    await world?.env.dispose();
    world = null;
  });

  async function pass(w: World, cursor?: unknown, trigger: SyncTrigger = 'manual') {
    return syncWithAdapter<unknown, NormalizedRecord>(w.adapter(trigger), {
      storageDir: w.env.artifactsDir,
      quarantineDir: w.env.quarantineDir,
      corpusDir: 'data/site',
      backfillLimit: 500,
      cursor,
    });
  }

  async function settle(w: World, trigger: SyncTrigger = 'manual') {
    let cursor: unknown;
    const results = [];
    for (let i = 0; i < 10; i++) {
      const r = await pass(w, cursor, trigger);
      cursor = r.cursor;
      results.push(r);
      if (r.error || (r.written === 0 && r.pruned === 0 && i > 0)) break;
    }
    return { results, cursor };
  }

  it('reads a bare domain as https, and refuses credentials and non-addresses', () => {
    const ok = parseWebsiteConfig({ sites: 'gezel.com, https://example.org/docs/intro' });
    expect(ok.problems).toEqual([]);
    expect(ok.config.sites).toEqual(['https://gezel.com/', 'https://example.org/docs/intro']);
    expect(ok.config.scopes[1]!.pathPrefix).toBe('/docs/');
    const bad = parseWebsiteConfig({ sites: ['https://me:secret@example.org/', 'not an address'] });
    expect(bad.problems.join(' ')).toMatch(/user name or password/);
    expect(bad.problems.join(' ')).toMatch(/is not a web address/);
    expect(parseWebsiteConfig({ sites: [] }).problems).toEqual(['Add at least one web address.']);
  });

  it('follows links inside the site, up to the depth, and lays records out by address', async () => {
    world = await makeWorld({ followLinks: 1 });
    world.site.set('/docs/intro', {
      title: 'Introduction',
      text: ['The introduction explains what the fake product does and who it is for.'],
      links: ['/docs/deep', 'https://elsewhere.test/page', '/logout'],
    });
    world.site.set('/docs/deep', {
      title: 'Deep',
      text: ['Two links away from the start address.'],
    });
    await settle(world);
    const records = await assertCorpusInvariants(world.env.artifactsDir, 'data/site');
    const paths = records.map((r) => r.path.replace(/\\/g, '/'));
    expect(paths.some((p) => /^site-test\/\d{3}--home--/.test(p))).toBe(true);
    expect(paths.some((p) => /^site-test\/docs\/\d{3}--intro--/.test(p))).toBe(true);
    expect(paths.some((p) => /deep/.test(p))).toBe(false);
    expect(world.site.served).not.toContain('/logout');
    const state = await readCrawlState(world.stateDir);
    expect(state.pages['https://site.test/docs/deep']?.state).toBe('skipped');
    expect(Object.keys(state.pages).some((u) => u.includes('elsewhere.test'))).toBe(false);
  });

  it('follows a start address that redirects within its site, and the links where it landed', async () => {
    world = await makeWorld({ sites: ['https://site.test/en/learn/intro'] });
    world.site.set('/en/learn/intro', { title: 'old', text: [], redirectTo: '/learn/intro' });
    world.site.set('/learn/intro', {
      title: 'Learn: intro',
      text: ['The introduction now lives under the learn folder of the site.'],
      links: ['/learn/intro', '/learn/next'],
    });
    world.site.set('/learn/next', {
      title: 'Learn: next',
      text: ['The next page in the learning path.'],
      links: ['/learn/intro'],
    });
    // The person's sync keeps going for the links the first page turned up.
    expect((await pass(world)).deferred).toBe(true);
    await settle(world);
    const state = await readCrawlState(world.stateDir);
    expect(state.pages['https://site.test/en/learn/intro']?.state).toBe('saved');
    expect(state.pages['https://site.test/learn/next']?.state).toBe('saved');
    // The address it landed on is the same page, not a second one.
    expect(state.pages['https://site.test/learn/intro']).toBeUndefined();
    expect(crawlPageFor(state, 'https://site.test/learn/intro')?.url).toBe(
      'https://site.test/en/learn/intro',
    );
    const corpus = await readCorpus(world.env.artifactsDir, 'data/site');
    expect(corpus.filter((r) => r.frontmatter.kind === 'web-page')).toHaveLength(2);
    // A second pass keeps both: the folder it landed in stays in scope.
    world.clock.now += 11 * MINUTE;
    await settle(world);
    expect(
      (await readCrawlState(world.stateDir)).pages['https://site.test/learn/next']?.state,
    ).toBe('saved');
  });

  it('skips a followed link that redirects to a page it already saves', async () => {
    world = await makeWorld();
    await settle(world);
    world.site.set('/docs/old-intro', { title: 'old', text: [], redirectTo: '/docs/intro' });
    const docs = world.site.get('/docs/')!;
    world.site.set('/docs/', { ...docs, links: [...(docs.links ?? []), '/docs/old-intro'] });
    world.clock.now += 11 * MINUTE;
    await settle(world);
    const state = await readCrawlState(world.stateDir);
    expect(state.pages['https://site.test/docs/old-intro']?.state).toBe('skipped');
    expect(state.pages['https://site.test/docs/old-intro']?.reason).toMatch(/already saves/);
    const corpus = await readCorpus(world.env.artifactsDir, 'data/site');
    expect(
      corpus.filter((r) => r.frontmatter.url === 'https://site.test/docs/old-intro'),
    ).toHaveLength(0);
  });

  it('retries a failed page when the person syncs again, but not within the same sync', async () => {
    world = await makeWorld();
    const intro = world.site.get('/docs/intro')!;
    world.site.set('/docs/intro', { ...intro, status: 500 });
    await settle(world);
    const url = 'https://site.test/docs/intro';
    const tries = () => world!.capturer.captured.filter((u) => u === url).length;
    expect((await readCrawlState(world.stateDir)).pages[url]?.state).toBe('failed');
    expect(tries()).toBe(1);
    world.site.set('/docs/intro', intro);
    // A follow-up pass of the same sync leaves it alone.
    world.clock.now += 2 * MINUTE;
    await pass(world);
    expect(tries()).toBe(1);
    // The schedule waits out the back-off.
    world.clock.now += 9 * MINUTE;
    await pass(world, undefined, 'schedule');
    expect(tries()).toBe(1);
    // Sync now tries it again.
    await pass(world);
    expect(tries()).toBe(2);
    expect((await readCrawlState(world.stateDir)).pages[url]?.state).toBe('saved');
  });

  it('honors robots.txt for followed links but not for the address the person typed', async () => {
    world = await makeWorld();
    world.site.robots = 'User-agent: *\nDisallow: /\nAllow: /blog/';
    await settle(world);
    const state = await readCrawlState(world.stateDir);
    expect(state.pages['https://site.test/']?.state).toBe('saved');
    expect(state.pages['https://site.test/blog/post-1']?.state).toBe('saved');
    expect(state.pages['https://site.test/docs/intro']?.state).toBe('skipped');
    expect(state.pages['https://site.test/docs/intro']?.reason).toMatch(/robots\.txt/);
  });

  it('keeps the earlier copy when a refresh meets a bot check', async () => {
    world = await makeWorld();
    await settle(world);
    const before = await readCorpus(world.env.artifactsDir, 'data/site');
    world.site.set('/docs/intro', { title: 'x', text: [], challenge: true });
    world.clock.now += 11 * MINUTE;
    const { results } = await settle(world);
    expect(results.reduce((n, r) => n + r.errors, 0)).toBe(0);
    const after = await readCorpus(world.env.artifactsDir, 'data/site');
    const intro = (list: typeof before) =>
      list.find((r) => r.frontmatter.url === 'https://site.test/docs/intro');
    expect(intro(after)?.body).toBe(intro(before)?.body);
    const state = await readCrawlState(world.stateDir);
    expect(state.pages['https://site.test/docs/intro']?.state).toBe('blocked');
  });

  it('keeps the earlier copy when a page comes back nearly empty', async () => {
    world = await makeWorld();
    const long = Array.from(
      { length: 30 },
      (_, i) => `Paragraph ${i} explains one more detail of the fake product in plain words.`,
    );
    world.site.set('/docs/intro', { title: 'Introduction', text: long });
    await settle(world);
    world.site.set('/docs/intro', { title: 'Introduction', text: ['Loading…'] });
    world.clock.now += 11 * MINUTE;
    await settle(world);
    const records = await readCorpus(world.env.artifactsDir, 'data/site');
    const intro = records.find((r) => r.frontmatter.url === 'https://site.test/docs/intro');
    expect(intro?.body).toContain('Paragraph 29');
  });

  it('logs a change in the month’s change log, refreshed in place', async () => {
    world = await makeWorld();
    await settle(world);
    world.site.set('/docs/intro', {
      title: 'Introduction',
      text: ['A completely rewritten introduction that now talks about the fake product pricing.'],
    });
    world.clock.now += 11 * MINUTE;
    await settle(world);
    const records = await readCorpus(world.env.artifactsDir, 'data/site');
    const logs = records.filter((r) => r.frontmatter.kind === 'web-site-changes');
    expect(logs).toHaveLength(1);
    expect(logs[0]!.body).toContain('Started following site.test');
    expect(logs[0]!.body).toContain('Changed: [Introduction](https://site.test/docs/intro)');
    expect(logs[0]!.body).toContain('> A completely rewritten introduction');
    const lookoutFeed = await readdir(join(world.stateDir, 'changes'));
    expect(lookoutFeed.length).toBeGreaterThan(0);
  });

  it('removes a site’s records when the person removes the site', async () => {
    world = await makeWorld();
    await settle(world);
    expect((await readCorpus(world.env.artifactsDir, 'data/site')).length).toBeGreaterThan(0);
    world.config = { sites: ['https://other.test/'] };
    new FakeSite('https://other.test', world.site.http).set('/', {
      title: 'Other',
      text: ['Another site entirely.'],
    });
    await settle(world);
    const records = await readCorpus(world.env.artifactsDir, 'data/site');
    expect(records.every((r) => r.frontmatter.site === 'other.test')).toBe(true);
  });

  it('stops a person’s pass at its budget and says more is due', async () => {
    world = await makeWorld({ followLinks: 1 });
    const many = Array.from({ length: 24 }, (_, i) => `/docs/p${i}`);
    for (const p of many)
      world.site.set(p, { title: `Page ${p}`, text: [`Text of ${p} for the budget test.`] });
    world.site.set('/', { title: 'Home', text: ['Home page with many links.'], links: many });
    // The first pass saves the home page and finds 24 links to follow.
    const first = await pass(world);
    expect(first.deferred).toBe(true);
    const second = await pass(world, first.cursor);
    expect(second.deferred).toBe(true);
    expect(world.capturer.captured.length).toBe(1 + 15);
    const third = await pass(world, second.cursor);
    expect(third.deferred).toBeUndefined();
    expect(world.capturer.captured.length).toBe(1 + 24);
  });

  it('links the screenshots it saved from the record body', async () => {
    world = await makeWorld({ screenshots: 1 });
    await settle(world);
    const records = await readCorpus(world.env.artifactsDir, 'data/site');
    const home = records.find((r) => r.frontmatter.url === 'https://site.test/');
    expect(home?.body).toMatch(/!\[The top of the page[^\]]*\]\(attachments\/\d{3}\/view-1\.jpg\)/);
    const state = await readCrawlState(world.stateDir);
    const shot = state.pages['https://site.test/']!.screenshots![0]!;
    expect(await readFile(join(world.env.artifactsDir, shot), 'utf8')).toContain('fake screenshot');
  });

  it('stops a signed-in pass at a sign-in wall and leaves every record as it was', async () => {
    world = await makeWorld();
    await settle(world);
    const before = await readCorpus(world.env.artifactsDir, 'data/site');
    await writeSession(world.stateDir, world.env.secrets, 'website:test', {
      version: 1,
      state: { cookies: [], origins: [] },
      savedAt: new Date(START).toISOString(),
      hosts: ['site.test'],
      probeUrl: 'https://site.test/',
    });
    world.site.set('/', { title: 'Sign in', text: [], signInWall: true });
    world.clock.now += 11 * MINUTE;
    const r = await pass(world);
    expect(r.error).toMatch(/Signed out of site\.test\. Sign in again/);
    expect(await readCorpus(world.env.artifactsDir, 'data/site')).toEqual(before);
  });
});
