import { describe, expect, it } from 'vitest';
import {
  parseGitbookSummary,
  parseJupyterBookToc,
  parseMkdocsNav,
  resolveOutlinePath,
  titleFromFolderName,
} from './outline.js';

describe('outline helpers', () => {
  it('title-cases slug-shaped folder names and leaves cased ones alone', () => {
    expect(titleFromFolderName('getting-started')).toBe('Getting Started');
    expect(titleFromFolderName('API-reference')).toBe('API Reference');
    expect(titleFromFolderName('Getting Started')).toBe('Getting Started');
    expect(titleFromFolderName('v2_notes')).toBe('V2 Notes');
    expect(titleFromFolderName('---')).toBe('---');
  });

  it('resolves outline paths inside the root and drops fragments', () => {
    expect(resolveOutlinePath('docs', 'a/../b.md#section')).toBe('docs/b.md');
    expect(resolveOutlinePath('', './a%20b.md?x=1')).toBe('a b.md');
    expect(resolveOutlinePath('', '../x.md')).toBeNull();
    expect(resolveOutlinePath('docs', '../../x.md')).toBeNull();
    expect(resolveOutlinePath('', '/abs.md')).toBeNull();
    expect(resolveOutlinePath('', '')).toBeNull();
  });
});

describe('GitBook SUMMARY.md', () => {
  it('reads parts, nesting, and page-led sections', () => {
    const summary = [
      '# Summary',
      '',
      '* [Introduction](README.md)',
      '* [Getting started](guide/start.md)',
      '  * [Install](guide/install.md#linux)',
      '  * [Configure](guide/configure.md)',
      '* Reference',
      '  * [CLI](reference/cli.md)',
      '  * [Website](https://example.com)',
      '',
      '## Appendix',
      '',
      '* [Glossary](appendix/glossary.md "Terms")',
      '* [Slides](appendix/deck.pdf)',
      '',
    ].join('\n');
    const outline = parseGitbookSummary(summary, 'SUMMARY.md');
    expect(outline.format).toBe('gitbook');
    expect(outline.consumed).toEqual(['SUMMARY.md']);
    expect(outline.root.entries).toEqual([{ file: 'README.md', title: 'Introduction', order: 1 }]);
    expect(outline.root.children.map((t) => [t.name, t.order])).toEqual([
      ['Getting started', 1],
      ['Reference', 2],
      ['Appendix', 3],
    ]);
    const [start, reference, appendix] = outline.root.children;
    expect(start?.entries.map((e) => [e.file, e.title, e.order])).toEqual([
      ['guide/start.md', 'Getting started', 1],
      ['guide/install.md', 'Install', 2],
      ['guide/configure.md', 'Configure', 3],
    ]);
    expect(reference?.entries).toEqual([{ file: 'reference/cli.md', title: 'CLI', order: 1 }]);
    expect(appendix?.entries).toEqual([
      { file: 'appendix/glossary.md', title: 'Glossary', order: 1 },
    ]);
    expect(outline.warnings).toEqual([expect.stringContaining('deck.pdf')]);
  });

  it('resolves pages relative to the summary, skips code fences, and refuses escapes', () => {
    const summary = [
      '* [Up](../../secret.md)',
      '```',
      '* [Not a page](fenced.md)',
      '```',
      '* [Page](./a.md)',
      '',
    ].join('\n');
    const outline = parseGitbookSummary(summary, 'docs/SUMMARY.md');
    expect(outline.root.entries).toEqual([{ file: 'docs/a.md', title: 'Page', order: 1 }]);
    expect(outline.warnings).toEqual([expect.stringContaining('leaves the catalog tree')]);
  });
});

describe('mkdocs.yml nav', () => {
  it('reads pages, titled pages and sections in order', () => {
    const config = {
      nav: [
        'index.md',
        { 'User Guide': ['guide/index.md', { Writing: 'guide/writing.md' }] },
        { About: [{ License: 'about/license.md' }, { 'Release notes': 'about/release-notes.md' }] },
        { Blog: 'https://example.com/blog' },
      ],
    };
    const outline = parseMkdocsNav(config, '');
    expect(outline?.format).toBe('mkdocs');
    expect(outline?.root.entries).toEqual([{ file: 'index.md', order: 1 }]);
    expect(outline?.root.children.map((t) => [t.name, t.order])).toEqual([
      ['User Guide', 1],
      ['About', 2],
    ]);
    expect(outline?.root.children[0]?.entries).toEqual([
      { file: 'guide/index.md', order: 1 },
      { file: 'guide/writing.md', title: 'Writing', order: 2 },
    ]);
    expect(outline?.root.children[1]?.entries.map((e) => e.title)).toEqual([
      'License',
      'Release notes',
    ]);
    expect(outline?.warnings).toEqual([]);
  });

  it('prefixes the docs directory, warns on odd entries, and is null without a nav', () => {
    expect(parseMkdocsNav({ site_name: 'x' }, '')).toBeNull();
    const outline = parseMkdocsNav(
      { nav: [{ Home: 'index.md' }, { Bad: 42 }, 'assets/logo.png'] },
      'docs',
    );
    expect(outline?.root.entries).toEqual([{ file: 'docs/index.md', title: 'Home', order: 1 }]);
    expect(outline?.warnings).toEqual([
      expect.stringContaining("'Bad'"),
      expect.stringContaining('logo.png'),
    ]);
    expect(() => parseMkdocsNav({ nav: 'index.md' }, '')).toThrow(/must be a list/);
  });
});

describe('Jupyter Book _toc.yml', () => {
  const files = [
    'intro.md',
    'part1/chapter1.md',
    'part1/chapter1/section1.md',
    'part1/chapter1/section2.md',
    'part2/chapter2.md',
    'notes/a.md',
    'notes/b.md',
  ];

  it('reads a jb-book with parts, chapters, sections, globs and links', () => {
    const doc = {
      format: 'jb-book',
      root: 'intro',
      parts: [
        {
          caption: 'Part One',
          chapters: [
            {
              file: 'part1/chapter1',
              sections: [
                { file: 'part1/chapter1/section1' },
                { file: 'part1/chapter1/section2', title: 'Second' },
              ],
            },
          ],
        },
        {
          caption: 'Part Two',
          chapters: [
            { file: 'part2/chapter2' },
            { file: 'part2/notebook' },
            { url: 'https://example.com', title: 'Site' },
            { glob: 'notes/*' },
          ],
        },
      ],
    };
    const outline = parseJupyterBookToc(doc, '', files);
    expect(outline.format).toBe('jupyter-book');
    expect(outline.root.entries).toEqual([{ file: 'intro.md', order: 1 }]);
    const [one, two] = outline.root.children;
    expect(one?.name).toBe('Part One');
    const chapter = one?.children[0];
    expect(chapter?.name).toBe('Chapter1');
    expect(chapter?.titleFromFile).toBe('part1/chapter1.md');
    expect(chapter?.entries.map((e) => [e.file, e.order])).toEqual([
      ['part1/chapter1.md', 1],
      ['part1/chapter1/section1.md', 2],
      ['part1/chapter1/section2.md', 3],
    ]);
    expect(chapter?.entries[2]?.title).toBe('Second');
    expect(two?.entries.map((e) => e.file)).toEqual([
      'part2/chapter2.md',
      'notes/a.md',
      'notes/b.md',
    ]);
    expect(outline.warnings).toEqual([expect.stringContaining('part2/notebook')]);
  });

  it('reads jb-article and the legacy list form', () => {
    const article = parseJupyterBookToc(
      { format: 'jb-article', root: 'intro', sections: [{ file: 'notes/a' }] },
      '',
      files,
    );
    expect(article.root.entries.map((e) => e.file)).toEqual(['intro.md', 'notes/a.md']);
    const legacy = parseJupyterBookToc(
      [{ file: 'intro' }, { part: 'Notes', chapters: [{ file: 'notes/a' }, { file: 'notes/b' }] }],
      '',
      files,
    );
    expect(legacy.root.entries.map((e) => e.file)).toEqual(['intro.md']);
    expect(legacy.root.children[0]?.name).toBe('Notes');
    expect(legacy.root.children[0]?.entries.map((e) => e.file)).toEqual([
      'notes/a.md',
      'notes/b.md',
    ]);
  });

  it('resolves files relative to the toc directory and rejects other shapes', () => {
    const outline = parseJupyterBookToc(
      { format: 'jb-book', root: 'intro', chapters: [{ file: 'notes/a' }] },
      'book',
      ['book/intro.md', 'book/notes/a.md'],
    );
    expect(outline.root.entries.map((e) => e.file)).toEqual(['book/intro.md', 'book/notes/a.md']);
    expect(() => parseJupyterBookToc('nope', '', files)).toThrow(/not a mapping or a list/);
  });
});
