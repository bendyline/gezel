import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { topicSortKeyForOrder } from '@bendyline/gezk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectTableOfContents, loadMarkdownCatalog } from './load.js';

/** Write a tree of files under `root`; keys are POSIX paths, values contents. */
async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, ...rel.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
}

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'gezk-md-toc-'));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('mkdocs nav', () => {
  let project: string;
  let docs: string;
  const warnings: string[] = [];

  beforeAll(async () => {
    project = join(scratch, 'mkdocs');
    docs = join(project, 'docs');
    await writeTree(project, {
      'mkdocs.yml': [
        'site_name: Site',
        'docs_dir: docs',
        'nav:',
        '  - Home: index.md',
        '  - User Guide:',
        '      - guide/index.md',
        '      - Writing: guide/writing.md',
        '  - About:',
        '      - License: about/license.md',
        'markdown_extensions:',
        '  - pymdownx.superfences:',
        '      custom_fences:',
        '        - name: mermaid',
        '          format: !!python/name:pymdownx.superfences.fence_code_format',
        '',
      ].join('\n'),
      'docs/index.md': '# Welcome\n\nFront page.\n',
      'docs/guide/index.md': '# Guide\n\nStart here.\n',
      'docs/guide/writing.md': '# Writing pages\n\nHow to write.\n',
      'docs/guide/extra.md': '# Extra\n\nNot in the nav.\n',
      'docs/about/license.md': '# License text\n\nMIT.\n',
    });
  });

  it('is detected from the project folder and files pages by the nav', async () => {
    const detected = await detectTableOfContents(docs, project);
    expect(detected).toEqual({ format: 'mkdocs', path: join(project, 'mkdocs.yml') });

    const source = await loadMarkdownCatalog(docs, {
      language: 'en',
      toc: { format: 'mkdocs' },
      onWarning: (m) => warnings.push(m),
    });
    expect(source.toc).toEqual({ format: 'mkdocs', path: join(project, 'mkdocs.yml') });
    const topics = new Map(source.topics.map((t) => [t.id, t]));
    expect(topics.get('user-guide')).toMatchObject({
      name: 'User Guide',
      sortKey: topicSortKeyForOrder(1),
    });
    expect(topics.get('about')).toMatchObject({ name: 'About', sortKey: topicSortKeyForOrder(2) });
    expect(topics.get('guide')).toMatchObject({ name: 'Guide' });
    expect(topics.get('general')?.name).toBe('General');

    const docsById = new Map(source.documents.map((d) => [d.id, d]));
    expect(docsById.get('index')).toMatchObject({
      title: 'Home',
      topicPath: ['general'],
      ordinal: 1,
    });
    expect(docsById.get('guide/index')).toMatchObject({
      title: 'Guide',
      topicPath: ['user-guide'],
      ordinal: 1,
    });
    expect(docsById.get('guide/writing')).toMatchObject({
      title: 'Writing',
      topicPath: ['user-guide'],
      ordinal: 2,
    });
    expect(docsById.get('about/license')).toMatchObject({
      title: 'License',
      topicPath: ['about'],
      ordinal: 1,
    });
    expect(docsById.get('guide/extra')).toMatchObject({ title: 'Extra', topicPath: ['guide'] });
    expect(docsById.get('guide/extra')?.ordinal).toBeUndefined();
    expect(warnings).toEqual([expect.stringContaining('guide/extra.md: not in the mkdocs table')]);
  });

  it('refuses a docs_dir outside the content root', async () => {
    const other = join(scratch, 'mkdocs-outside');
    await writeTree(other, {
      'mkdocs.yml': 'nav:\n  - index.md\n',
      'elsewhere/index.md': '# X\n',
    });
    await expect(
      loadMarkdownCatalog(join(other, 'elsewhere'), {
        language: 'en',
        toc: { format: 'mkdocs', path: join(other, 'mkdocs.yml') },
      }),
    ).rejects.toThrow(/docs_dir .* outside the content root/);
  });
});

describe('GitBook SUMMARY.md', () => {
  let book: string;
  const warnings: string[] = [];

  beforeAll(async () => {
    book = join(scratch, 'gitbook');
    await writeTree(book, {
      'README.md': '# The Book\n\nAn introduction.\n',
      'SUMMARY.md': [
        '# Summary',
        '',
        '* [Introduction](README.md)',
        '* [Getting started](guide/start.md)',
        '  * [Install](guide/install.md)',
        '',
        '## Appendix',
        '',
        '* [CLI](reference/cli.md)',
        '',
      ].join('\n'),
      'guide/start.md': '# Start\n\nBegin.\n',
      'guide/install.md': '# Installing\n\nSteps.\n',
      'reference/cli.md': '# Command line\n\nFlags.\n',
      'orphan.md': '# Orphan\n\nNot listed.\n',
    });
  });

  it('is detected, consumes the summary, and leads sections with their pages', async () => {
    expect(await detectTableOfContents(book)).toEqual({
      format: 'gitbook',
      path: join(book, 'SUMMARY.md'),
    });
    const source = await loadMarkdownCatalog(book, {
      language: 'en',
      toc: { format: 'gitbook' },
      onWarning: (m) => warnings.push(m),
    });
    const ids = source.documents.map((d) => d.id);
    expect(ids).not.toContain('SUMMARY');
    const docsById = new Map(source.documents.map((d) => [d.id, d]));
    expect(docsById.get('README')).toMatchObject({
      title: 'Introduction',
      topicPath: ['general'],
      ordinal: 1,
    });
    expect(docsById.get('guide/start')).toMatchObject({
      title: 'Getting started',
      topicPath: ['getting-started'],
      ordinal: 1,
    });
    expect(docsById.get('guide/install')).toMatchObject({
      title: 'Install',
      topicPath: ['getting-started'],
      ordinal: 2,
    });
    expect(docsById.get('reference/cli')).toMatchObject({
      title: 'CLI',
      topicPath: ['appendix'],
      ordinal: 1,
    });
    expect(docsById.get('orphan')).toMatchObject({ title: 'Orphan', topicPath: ['general'] });
    const topics = new Map(source.topics.map((t) => [t.id, t]));
    expect(topics.get('getting-started')?.sortKey).toBe(topicSortKeyForOrder(1));
    expect(topics.get('appendix')?.sortKey).toBe(topicSortKeyForOrder(2));
    expect(warnings).toEqual([expect.stringContaining('orphan.md: not in the gitbook table')]);
  });
});

describe('Jupyter Book _toc.yml', () => {
  let bookDir: string;

  beforeAll(async () => {
    bookDir = join(scratch, 'jupyter');
    await writeTree(bookDir, {
      '_toc.yml': [
        'format: jb-book',
        'root: intro',
        'parts:',
        '  - caption: Part One',
        '    chapters:',
        '      - file: part1/chapter1',
        '        sections:',
        '          - file: part1/chapter1/section1',
        '      - file: part1/notebook',
        '',
      ].join('\n'),
      'intro.md': '# Introduction\n\nHello.\n',
      'part1/chapter1.md': '# Chapter One\n\nThe chapter.\n',
      'part1/chapter1/section1.md': '# Section One\n\nThe section.\n',
    });
  });

  it('is detected and names a chapter topic after the chapter page', async () => {
    expect(await detectTableOfContents(bookDir)).toEqual({
      format: 'jupyter-book',
      path: join(bookDir, '_toc.yml'),
    });
    const warnings: string[] = [];
    const source = await loadMarkdownCatalog(bookDir, {
      language: 'en',
      toc: { format: 'jupyter-book' },
      onWarning: (m) => warnings.push(m),
    });
    const topics = new Map(source.topics.map((t) => [t.id, t]));
    expect(topics.get('part-one')).toMatchObject({ name: 'Part One' });
    expect(topics.get('chapter1')).toMatchObject({ name: 'Chapter One', parentId: 'part-one' });
    const docsById = new Map(source.documents.map((d) => [d.id, d]));
    expect(docsById.get('intro')).toMatchObject({ topicPath: ['general'], ordinal: 1 });
    expect(docsById.get('part1/chapter1')).toMatchObject({
      topicPath: ['part-one', 'chapter1'],
      ordinal: 1,
    });
    expect(docsById.get('part1/chapter1/section1')).toMatchObject({
      topicPath: ['part-one', 'chapter1'],
      ordinal: 2,
    });
    expect(warnings).toEqual([expect.stringContaining('part1/notebook')]);
  });
});

describe('Hugo conventions', () => {
  let site: string;
  const warnings: string[] = [];

  beforeAll(async () => {
    site = join(scratch, 'hugo');
    await writeTree(site, {
      '_index.md': '---\ntitle: My Site\n---\n',
      'docs/_index.md':
        '---\ntitle: Documentation\ndescription: All the docs.\nweight: 2\n---\nWelcome to the docs.\n',
      'docs/install.md': '---\ntitle: Install\nweight: 20\n---\nSteps.\n',
      'docs/intro.md': '---\ntitle: Intro\ndescription: Why.\nweight: 10\n---\nBecause.\n',
      'docs/draft.md': '---\ntitle: Draft\ndraft: true\n---\nNot yet.\n',
      'blog/_index.md': '---\ntitle: Blog\nweight: 1\n---\n',
      'blog/post.md': '# A post\n\nWords.\n',
    });
  });

  it('is detected from _index.md pages and honors weight, draft and section pages', async () => {
    expect(await detectTableOfContents(site)).toEqual({ format: 'hugo' });
    const source = await loadMarkdownCatalog(site, {
      language: 'en',
      toc: { format: 'hugo' },
      onWarning: (m) => warnings.push(m),
    });
    expect(source.toc).toEqual({ format: 'hugo' });
    const topics = new Map(source.topics.map((t) => [t.id, t]));
    expect(topics.get('docs')).toMatchObject({
      name: 'Documentation',
      description: 'All the docs.',
      sortKey: topicSortKeyForOrder(2),
    });
    expect(topics.get('blog')).toMatchObject({ name: 'Blog', sortKey: topicSortKeyForOrder(1) });
    expect(topics.get('general')?.name).toBe('My Site');

    const docsById = new Map(source.documents.map((d) => [d.id, d]));
    expect(docsById.get('docs/_index')).toMatchObject({
      title: 'Documentation',
      summary: 'All the docs.',
      ordinal: -2147483648,
    });
    expect(docsById.get('docs/intro')).toMatchObject({ ordinal: 10, summary: 'Why.' });
    expect(docsById.get('docs/install')).toMatchObject({ ordinal: 20 });
    expect(docsById.get('blog/post')?.ordinal).toBeUndefined();
    expect(docsById.has('docs/draft')).toBe(false);
    expect(docsById.has('blog/_index')).toBe(false);
    expect(docsById.has('_index')).toBe(false);
    expect(warnings).toEqual([expect.stringContaining('docs/draft.md: skipped, draft page')]);
  });
});

describe('folder-derived names', () => {
  it('title-cases slug folders and keeps cased ones', async () => {
    const tree = join(scratch, 'folders');
    await writeTree(tree, {
      'getting-started/a.md': '# A\n',
      'API/b.md': '# B\n',
    });
    expect(await detectTableOfContents(tree)).toEqual({ format: 'folders' });
    const source = await loadMarkdownCatalog(tree, { language: 'en' });
    expect(source.toc).toEqual({ format: 'folders' });
    expect(source.topics.map((t) => t.name).sort()).toEqual(['API', 'Getting Started']);
  });
});
