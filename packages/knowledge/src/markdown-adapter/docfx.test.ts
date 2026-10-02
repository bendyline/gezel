import { describe, expect, it } from 'vitest';
import {
  type DocfxProject,
  docfxGlob,
  docfxPublishes,
  parseDocfxJson,
  parseDocfxToc,
} from './docfx.js';
import type { OutlineTopic } from './outline.js';

const project: DocfxProject = parseDocfxJson({
  build: {
    content: [
      {
        files: ['**/*.md', '**/*.yml'],
        exclude: ['**/includes/**', 'iot/**'],
        src: 'articles',
        dest: '.',
      },
      { files: ['**/*.md', '**/*.yml'], src: 'articles/iot', dest: './iot/' },
      { files: ['**/*.yml'], src: 'bread', dest: 'bread' },
    ],
    globalMetadata: { breadcrumb_path: '/azure/bread/toc.json' },
  },
});

/** A topic tree as `name: [files…, {child}…]`, for compact assertions. */
function shape(topic: OutlineTopic): unknown[] {
  return [
    ...topic.entries.map((entry) => entry.file),
    ...topic.children.map((child) => ({ [child.name]: shape(child) })),
  ];
}

describe('docfx.json', () => {
  it('reads content groups and the breadcrumb path', () => {
    expect(project.breadcrumbPath).toBe('/azure/bread/toc.json');
    expect(project.content.map((g) => [g.src, g.dest])).toEqual([
      ['articles', ''],
      ['articles/iot', 'iot'],
      ['bread', 'bread'],
    ]);
  });

  it('publishes the union of its groups, honoring excludes', () => {
    expect(docfxPublishes(project, 'articles/api/overview.md')).toBe(true);
    expect(docfxPublishes(project, 'articles/overview.md')).toBe(true);
    expect(docfxPublishes(project, 'articles/api/includes/snippet.md')).toBe(false);
    // Excluded by the articles group, published by its own.
    expect(docfxPublishes(project, 'articles/iot/overview.md')).toBe(true);
    expect(docfxPublishes(project, 'README.md')).toBe(false);
    expect(docfxPublishes(project, 'bread/notes.md')).toBe(false);
    expect(docfxPublishes(parseDocfxJson({}), 'README.md')).toBe(true);
  });

  it('globs match across and within folders', () => {
    expect(docfxGlob('**/*.md').test('a.md')).toBe(true);
    expect(docfxGlob('**/*.md').test('a/b/c.MD')).toBe(true);
    expect(docfxGlob('*.md').test('a/b.md')).toBe(false);
    expect(docfxGlob('iot/**').test('iot/a/b.md')).toBe(true);
    expect(docfxGlob('**/{media,images}/**').test('x/images/y.png')).toBe(true);
  });
});

describe('docfx tables of contents', () => {
  const files = [
    'articles/api-center/overview.md',
    'articles/api-center/unlisted.md',
    'articles/api-center/reference/cli.md',
    'articles/shared/limits.md',
    'articles/iot/overview.md',
    'articles/nat/overview.md',
    'articles/loose/page.md',
  ];
  const tocs = new Map<string, unknown>([
    [
      'bread/toc.yml',
      {
        items: [
          {
            name: 'Azure',
            tocHref: '/azure/',
            topicHref: '/azure/index',
            items: [
              {
                name: 'API Center',
                tocHref: '/azure/api-center/',
                topicHref: '/azure/api-center/',
              },
              { name: 'Moved away', tocHref: '/azure/gone/', topicHref: '/azure/gone/' },
              { name: 'IoT', tocHref: '/azure/iot/', topicHref: '/azure/iot/index' },
            ],
          },
        ],
      },
    ],
    [
      'articles/api-center/TOC.yml',
      [
        { name: 'Azure API Center documentation', href: 'index.yml' },
        {
          name: 'Get started',
          items: [
            { name: 'Overview', href: 'overview.md' },
            { name: 'Limits', href: '../shared/limits.md?toc=/azure/api-center/toc.json#limits' },
            { name: 'Elsewhere', href: '/entra/identity/overview' },
            { name: 'Stale', href: 'removed.md' },
          ],
        },
        { name: 'Reference', href: 'reference/' },
      ],
    ],
    ['articles/api-center/reference/toc.yml', [{ name: 'CLI', href: 'cli.md' }]],
    ['articles/iot/TOC.yml', [{ name: 'What is IoT?', href: 'overview.md' }]],
    [
      'articles/shared/toc.yml',
      {
        items: [
          { name: 'Shared limits documentation', href: 'index.yml' },
          { name: 'Limits', href: 'limits.md' },
        ],
      },
    ],
    [
      'articles/nat/toc.yml',
      {
        items: [
          { name: 'Azure NAT Gateway documentation', href: 'index.yml' },
          { name: 'Overview', href: 'overview.md' },
        ],
      },
    ],
    [
      'articles/nat/breadcrumb/toc.yml',
      [{ name: 'Azure', tocHref: '/azure/', items: [{ name: 'NAT', tocHref: '/azure/nat/' }] }],
    ],
  ]);

  const outline = parseDocfxToc({ tocs, files, project });

  it('starts from the breadcrumb and grafts the TOCs it missed', () => {
    expect(outline.entry).toBe('bread/toc.yml');
    // The single "Azure" node is the catalog itself and is unwrapped; a
    // breadcrumb node whose folder left the tree yields nothing.
    expect(shape(outline.root)).toEqual([
      {
        'API Center': [
          'articles/api-center/unlisted.md',
          { 'Get started': ['articles/api-center/overview.md'] },
          { Reference: ['articles/api-center/reference/cli.md'] },
        ],
      },
      { IoT: ['articles/iot/overview.md'] },
      { 'Azure NAT Gateway': ['articles/nat/overview.md'] },
      { 'Shared limits': ['articles/shared/limits.md'] },
    ]);
  });

  it('files a cross-linked page with the TOC of its own folder', () => {
    const getStarted = outline.root.children[0]?.children[0];
    expect(getStarted?.entries.map((e) => e.file)).not.toContain('articles/shared/limits.md');
  });

  it('reports stale links and unlisted pages in one line each', () => {
    expect(outline.warnings).toEqual([
      expect.stringMatching(/^1 pages named by a toc\.yml .*articles\/api-center\/removed\.md$/),
      expect.stringMatching(/^1 pages are in no toc\.yml.*articles\/api-center\/unlisted\.md$/),
    ]);
  });

  it('infers the site base from the entry when no breadcrumb path is configured', () => {
    const inferred = parseDocfxToc({
      tocs,
      files,
      project: { content: project.content },
      entry: 'bread/toc.yml',
    });
    expect(shape(inferred.root)).toEqual(shape(outline.root));
  });

  it('without a breadcrumb or root TOC, grafts every TOC at the top', () => {
    const flat = parseDocfxToc({
      tocs: new Map([...tocs].filter(([file]) => !file.startsWith('bread/'))),
      files,
    });
    expect(flat.entry).toBeUndefined();
    expect(flat.root.children.map((topic) => topic.name)).toEqual([
      'Azure API Center',
      'Iot',
      'Azure NAT Gateway',
      'Shared limits',
    ]);
  });
});
