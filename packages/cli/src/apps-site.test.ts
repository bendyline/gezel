import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogItemSummary, CatalogKind } from '@bendyline/gezel';
import { afterEach, describe, expect, it } from 'vitest';
import { writeAppsSite } from './apps-site.js';
import { type SiteCatalogSource, buildSiteCatalog } from './handboek-site-catalog.js';

function summary(kind: CatalogKind, manifest: Record<string, unknown>) {
  return { sourceId: 'bundled', kind, manifest } as unknown as CatalogItemSummary;
}

const items: Partial<Record<CatalogKind, CatalogItemSummary[]>> = {
  'gezel-template': [
    summary('gezel-template', {
      id: 'reisleider',
      name: 'Reisleider',
      role: 'Reisleider',
      description: 'Plans trips you can be present for. More detail.',
      version: '1.0.0',
    }),
  ],
  'craftbook-template': [
    summary('craftbook-template', {
      id: 'day-plan',
      name: 'Plan a day',
      description: 'Turns a city into a walkable day. Then more.',
    }),
  ],
  'project-type': [
    summary('project-type', {
      id: 'trip-planner',
      name: 'Trip Planner',
      description: 'Plan a trip you’ll actually be present for. Second sentence.',
      category: 'events',
      tags: ['travel'],
      logo: 'logo.webp',
      version: '1.0.6',
      gezels: [{ templateId: 'reisleider', voorman: true }],
      craftbooks: ['day-plan'],
      tools: [
        { name: 'plan_day', description: 'Write one day of the itinerary. Use ISO dates.' },
        { name: 'page_plan_day', description: 'Page alias.' },
      ],
      params: { properties: { destination: { title: 'Where are you going?' } } },
      workspaceSeed: ['trip.json'],
      pages: {
        entry: 'dashboard/index.html',
        api: 1,
        reads: [{ source: 'workspace', path: 'trip.json' }],
        tools: ['page_plan_day'],
      },
    }),
    summary('project-type', {
      id: 'email',
      name: 'Email <Inbox>',
      description: 'Sync an inbox.',
      category: 'communication',
      version: '1.0.0',
    }),
  ],
};

const files: Record<string, string> = {
  'project-type/trip-planner/logo.webp': 'WEBP',
  'project-type/trip-planner/versions/1.0.6/pages/dashboard/index.html':
    '<!doctype html><html><head><meta charset="utf-8"></head><body><script>window.gezel||window.makeDemoGezel({})</script></body></html>',
};

const catalog: SiteCatalogSource = {
  list: async (kind) => items[kind] ?? [],
  listItemFiles: async (kind, id) =>
    Object.keys(files)
      .filter((k) => k.startsWith(`${kind}/${id}/`))
      .map((k) => k.slice(`${kind}/${id}/`.length)),
  readItemFile: async (kind, id, relPath, _sourceId, version) => {
    const key = version
      ? `${kind}/${id}/versions/${version}/${relPath}`
      : `${kind}/${id}/${relPath}`;
    return key in files ? Buffer.from(files[key]!) : null;
  },
};

describe('writeAppsSite', () => {
  let out = '';
  afterEach(async () => {
    if (out) await rm(out, { recursive: true, force: true });
  });

  it('writes a library, one page per app, and each page demo beside it', async () => {
    out = await mkdtemp(join(tmpdir(), 'gezel-apps-site-'));
    const site = await buildSiteCatalog(catalog);
    const result = await writeAppsSite(catalog, site, {
      out,
      docsBase: '/docs/',
      siteOrigin: 'https://gezel.com',
      openInGezel: true,
    });
    expect(result).toEqual({ apps: 2, demos: 1 });

    const index = await readFile(join(out, 'index.html'), 'utf8');
    expect(index).toContain('<a href="trip-planner/">');
    expect(index).toContain('Try it here');
    expect(index).toContain('Email &lt;Inbox&gt;');
    expect(index.indexOf('Trip Planner')).toBeLessThan(index.indexOf('Email &lt;Inbox&gt;'));
    expect(index).toContain('data-filter="events">Events &amp; Journeys</button>');
    expect(index).toContain('<link rel="canonical" href="https://gezel.com/apps/">');

    const page = await readFile(join(out, 'trip-planner', 'index.html'), 'utf8');
    expect(page).toContain('src="demo/dashboard/index.html"');
    expect(page).toContain('sandbox="allow-scripts allow-forms allow-modals"');
    expect(page).toContain('href="/docs/role-template/reisleider/"><strong>Trip Planner</strong>');
    expect(page).toContain('href="/docs/craftbook/day-plan/"><strong>Plan a day</strong>');
    expect(page).toContain('<strong>Plan day</strong><span>Write one day of the itinerary.</span>');
    expect(page).not.toContain('Page plan day');
    expect(page).toContain('<em>Where are you going?</em>');
    expect(page).toContain('<code>trip.json</code>');
    // Hidden until the inline script finds a computer to open it on.
    expect(page).toContain(
      '<span class="open-in-gezel" data-gezel-open hidden><a class="button" href="gezel://app/trip-planner">Open in Gezel</a>',
    );
    expect(page).toContain('href="/platform/#ai-apps">Make one like this');
    expect(page).toContain("document.querySelectorAll('[data-gezel-open]')");
    expect(await readFile(join(out, 'trip-planner', 'logo.webp'), 'utf8')).toBe('WEBP');

    const demo = await readFile(
      join(out, 'trip-planner', 'demo', 'dashboard', 'index.html'),
      'utf8',
    );
    expect(demo).toContain('"companion":{"role":"Trip Planner"}');
    expect(demo).toMatch(/src="\.\.\/\.\.\/\.\.\/_gezel-demo\/bootstrap-[0-9a-f]{16}\.js"/);
    expect((await readdir(join(out, '_gezel-demo'))).some((f) => f.endsWith('.js'))).toBe(true);

    const native = await readFile(join(out, 'email', 'index.html'), 'utf8');
    expect(native).toContain('Runs in the Gezel app');
    expect(native).not.toContain('<iframe');
  });

  it('leaves out Open in Gezel until the export asks for it', async () => {
    out = await mkdtemp(join(tmpdir(), 'gezel-apps-site-'));
    const site = await buildSiteCatalog(catalog);
    await writeAppsSite(catalog, site, { out, docsBase: '/docs/' });
    const page = await readFile(join(out, 'trip-planner', 'index.html'), 'utf8');
    expect(page).not.toContain('gezel://');
    expect(page).not.toContain('data-gezel-open');
    expect(page).toContain('<a class="button" href="/#download">Get Gezel</a>');
  });
});
