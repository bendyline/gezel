import type { CatalogItemSummary, CatalogKind } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  MODEL_CATALOG_ID,
  ROLE_CATALOG_ID,
  TOOLSET_CATALOG_ID,
  type SiteCatalogSource,
  buildSiteCatalog,
  demoSectionHtml,
  insertAfterTitle,
  insertDemoSection,
} from './handboek-site-catalog.js';

function summary(kind: CatalogKind, manifest: Record<string, unknown>, sourceId = 'bundled') {
  return { sourceId, kind, manifest } as unknown as CatalogItemSummary;
}

function stubCatalog(items: Partial<Record<CatalogKind, CatalogItemSummary[]>>, files: Record<string, string>) {
  const source: SiteCatalogSource = {
    list: async (kind) => items[kind] ?? [],
    listItemFiles: async (kind, id) =>
      Object.keys(files)
        .filter((k) => k.startsWith(`${kind}/${id}/`))
        .map((k) => k.slice(`${kind}/${id}/`.length)),
    readItemFile: async (kind, id, relPath, _sourceId, version) => {
      const key = version ? `${kind}/${id}/versions/${version}/${relPath}` : `${kind}/${id}/${relPath}`;
      return key in files ? Buffer.from(files[key]!) : null;
    },
  };
  return source;
}

const catalog = stubCatalog(
  {
    'chat-model': [
      summary('chat-model', {
        id: 'small-q4',
        name: 'Small | Fast',
        description: 'A small model. Second sentence.',
        recoScore: 10,
        approxSizeBytes: 2_500_000_000,
        contextWindow: 32768,
        llamaCpp: { quantization: 'Q4_K_M' },
        mlx: {},
        license: 'Apache-2.0',
        category: 'general',
      }),
      summary('chat-model', {
        id: 'big-q4',
        name: 'Big',
        description: 'A big model.',
        recoScore: 90,
        ds4: { quantization: 'IQ2_XXS' },
      }),
    ],
    toolset: [
      summary('toolset', { id: 'builtin.memory', name: 'Memory', description: 'x' }, 'builtin'),
      summary('toolset', { id: 'docblocks', name: 'DocBlocks Documents', description: 'Office files.' }),
      ...Array.from({ length: 1234 }, (_, i) =>
        summary('toolset', { id: `c${i}`, name: `C${i}`, description: '' }, 'community'),
      ),
    ],
    'gezel-template': [
      summary('gezel-template', {
        id: 'aanjager',
        name: 'Aanjager',
        description: 'Keeps a community drive moving. More.',
        version: '1.0.0',
        about: 'about.md',
        meesterCandidate: true,
      }),
    ],
    'project-type': [
      summary('project-type', {
        id: 'with-demo',
        name: 'With demo',
        description: 'd',
        version: '1.0.0',
        pages: { entry: 'dashboard/index.html' },
      }),
      summary('project-type', {
        id: 'escapes',
        name: 'Escapes',
        description: 'd',
        version: '1.0.0',
        pages: { entry: '../secret.html' },
      }),
    ],
    'craftbook-template': [
      summary('craftbook-template', { id: 'pitch-deck', name: 'Pitch Deck', description: 'Make a deck. More.', logo: 'logo.webp' }),
      summary('craftbook-template', { id: 'odd-logo', name: 'Odd', description: 'x', logo: '../../etc/passwd' }),
    ],
  },
  {
    'gezel-template/aanjager/versions/1.0.0/about.md': '# Who you are\n\nYou keep the drive moving.',
    'project-type/with-demo/versions/1.0.0/pages/dashboard/index.html': '<h1>demo</h1>',
    'project-type/with-demo/versions/1.0.0/pages/dashboard/app.js': 'void 0',
    'project-type/with-demo/versions/1.0.0/about.md': 'not a page file',
    'project-type/escapes/versions/1.0.0/pages/x.html': 'x',
    'craftbook-template/pitch-deck/logo.webp': 'WEBP',
    'craftbook-template/odd-logo/logo.webp': 'WEBP',
  },
);

describe('buildSiteCatalog', () => {
  it('lists chat models recommended-first, with a page each and safe table cells', async () => {
    const { pages } = await buildSiteCatalog(catalog);
    const index = pages.find((p) => p.entry.id === MODEL_CATALOG_ID)!;
    expect(index.listed).toBe(true);
    expect(index.markdown.indexOf('[Big](model/big-q4)')).toBeLessThan(
      index.markdown.indexOf('model/small-q4'),
    );
    expect(index.markdown).toContain('[Small \\| Fast](model/small-q4) | 2.5 GB | 33K |');
    const page = pages.find((p) => p.entry.id === 'model/big-q4')!;
    expect(page.listed).toBe(false);
    expect(page.markdown).toContain('| Runs on | DwarfStar |');
    expect(page.markdown).toContain('| Quantization | IQ2_XXS |');
  });

  it('lists add-on toolsets but not built-in groups, and rounds the community count', async () => {
    const { pages } = await buildSiteCatalog(catalog);
    const md = pages.find((p) => p.entry.id === TOOLSET_CATALOG_ID)!.markdown;
    expect(md).toContain('| DocBlocks Documents | Office files. |');
    expect(md).not.toContain('| Memory |');
    expect(md).toContain('about 1,200 MCP servers');
  });

  it('gives each role template a page whose brief cannot add a second title', async () => {
    const { pages } = await buildSiteCatalog(catalog);
    expect(pages.find((p) => p.entry.id === ROLE_CATALOG_ID)!.markdown).toContain(
      '[Aanjager](role-template/aanjager)',
    );
    const page = pages.find((p) => p.entry.id === 'role-template/aanjager')!;
    expect(page.markdown).toContain('### Who you are');
    expect(page.markdown).not.toMatch(/^# Who you are/m);
    expect(page.markdown).toContain('act as your Meester');
  });

  it('replaces the craftbook index with a gallery and keeps art to the published file name', async () => {
    const { pages, craftbookArt } = await buildSiteCatalog(catalog);
    const gallery = pages.find((p) => p.entry.id === 'craftbooks-index')!;
    expect(gallery.replaces).toBe(true);
    expect(gallery.html).toContain('<a href="../craftbook/pitch-deck/"><img src="../craftbook/pitch-deck/logo.webp"');
    expect([...craftbookArt.keys()]).toEqual(['pitch-deck']);
  });

  it('copies only page files for a demo, and skips entries that escape the pages folder', async () => {
    const { demos } = await buildSiteCatalog(catalog);
    expect(demos).toHaveLength(1);
    expect(demos[0]!.projectTypeId).toBe('with-demo');
    expect(demos[0]!.files.map((f) => f.path).sort()).toEqual([
      'dashboard/app.js',
      'dashboard/index.html',
    ]);
  });
});

describe('page insertions', () => {
  it('places the demo after the opening paragraph and art after the title', () => {
    const body = '<h1>T</h1>\n<p>Lead.</p>\n<h2>More</h2>';
    const demo = demoSectionHtml(
      { projectTypeId: 'x', entry: 'dash board/index.html', files: [] },
      'X "room"',
    );
    expect(demo).toContain('src="demo/dash%20board/index.html"');
    expect(demo).toContain('title="X &quot;room&quot; demo"');
    expect(insertDemoSection(body, '<section/>')).toBe(
      '<h1>T</h1>\n<p>Lead.</p>\n<section/>\n<h2>More</h2>',
    );
    expect(insertAfterTitle(body, '<img>')).toBe('<h1>T</h1>\n<img>\n<p>Lead.</p>\n<h2>More</h2>');
  });
});
