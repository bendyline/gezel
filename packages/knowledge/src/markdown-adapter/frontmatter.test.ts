import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { topicSortKeyForOrder } from '@bendyline/gezk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_PNG } from '../test/fixture.js';
import { parseMarkdownFrontMatter } from './frontmatter.js';
import { loadMarkdownCatalog } from './load.js';

/** A documentation tree shaped like the Handboek: areas, shelves, ids with slashes, negative orders. */
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gezk-handboek-shaped-'));
  await mkdir(join(root, 'conceptual'), { recursive: true });
  await mkdir(join(root, 'technical'), { recursive: true });
  await mkdir(join(root, 'whats-new'), { recursive: true });
  await mkdir(join(root, 'assets'), { recursive: true });
  await mkdir(join(root, 'technical', 'img'), { recursive: true });
  await writeFile(join(root, 'assets', 'mark.png'), FIXTURE_PNG);
  await writeFile(join(root, 'technical', 'img', 'flow.png'), FIXTURE_PNG);
  await writeFile(join(root, 'README.md'), '# Authoring contract\n\nNot an article.\n');
  await writeFile(join(root, 'technical', '_topic.yaml'), 'name: Technical\norder: 5\n');
  await writeFile(
    join(root, 'conceptual', 'welcome.md'),
    [
      '---',
      'id: welcome',
      'title: Welcome',
      'summary: Start here.',
      'order: 1',
      'ogHeadline: The front door',
      'siteVisible: true',
      '---',
      '# Welcome',
      '',
      '![mark](../assets/mark.png)',
      '',
      'Read about [the crew](the-crew.md#roster) and [craftbooks](../technical/craftbooks.md).',
      'See also [the spec](https://example.com/spec) and [outside](../../elsewhere.md).',
      '',
      '```md',
      'Not rewritten: [the crew](the-crew.md)',
      '```',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(root, 'conceptual', 'the-crew.md'),
    '---\nid: the-crew\ntitle: The crew\norder: 2\n---\n# The crew\n\nEveryone.\n',
  );
  await writeFile(
    join(root, 'technical', 'craftbooks.md'),
    [
      '---',
      'id: craftbooks',
      'title: Craftbooks',
      'order: 3',
      'subcategory:',
      '  id: how-gezel-works',
      '  title: How Gezel works',
      '  order: 1',
      'aliases:',
      '  - recipes',
      '  - playbooks',
      '---',
      '# Craftbooks',
      '',
      '![flow](img/flow.png)',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(root, 'technical', 'architecture.md'),
    '---\nid: architecture\ntitle: Architecture\norder: 1\nsubcategory:\n  id: how-gezel-works\n  title: How Gezel works\n  order: 1\n---\n# Architecture\n',
  );
  await writeFile(
    join(root, 'whats-new', '1.26234.md'),
    '---\nid: whats-new/1.26234\ntitle: "1.26234"\nsummary: A release.\norder: -26234\n---\n# 1.26234\n',
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('parseMarkdownFrontMatter', () => {
  it('parses nested mappings, lists and negative integers under the core schema', () => {
    const { data, body } = parseMarkdownFrontMatter(
      '---\ntitle: T\norder: -3\nsub:\n  id: x\n  order: 2\ntags: [a, b]\nwhen: 2026-09-05\n---\nbody\n',
    );
    expect(data).toEqual({
      title: 'T',
      order: -3,
      sub: { id: 'x', order: 2 },
      tags: ['a', 'b'],
      when: '2026-09-05',
    });
    expect(body).toBe('body\n');
  });

  it('treats a source without a fence as all body and refuses an unclosed fence', () => {
    expect(parseMarkdownFrontMatter('# Just body\n')).toEqual({ data: {}, body: '# Just body\n' });
    expect(() => parseMarkdownFrontMatter('---\ntitle: T\n# oops\n')).toThrow(/not closed/);
  });

  it('refuses aliases, tags and non-mapping documents', () => {
    expect(() => parseMarkdownFrontMatter('---\na: &x 1\nb: *x\n---\n')).toThrow();
    expect(() => parseMarkdownFrontMatter('---\nd: !!js/function "1"\n---\n')).toThrow();
    expect(() => parseMarkdownFrontMatter('---\n- a\n- b\n---\n')).toThrow(/mapping/);
  });
});

describe('loadMarkdownCatalog with a documentation tree', () => {
  it('honors ids, ordinals, shelves, sidecars and overrides', async () => {
    const source = await loadMarkdownCatalog(root, {
      language: 'en',
      ignore: ['README.md'],
      topics: { conceptual: { name: 'Concepts', order: 0 }, 'whats-new': { order: 9 } },
      uri: { publisherId: 'bendyline', catalogId: 'gezel-handboek' },
    });
    const topics = new Map(source.topics.map((t) => [t.id, t]));
    expect(topics.get('conceptual')).toEqual({
      id: 'conceptual',
      name: 'Concepts',
      sortKey: topicSortKeyForOrder(0),
    });
    expect(topics.get('technical')).toEqual({
      id: 'technical',
      name: 'Technical',
      sortKey: topicSortKeyForOrder(5),
    });
    expect(topics.get('whats-new')?.sortKey).toBe(topicSortKeyForOrder(9));
    const shelf = topics.get('technical-how-gezel-works');
    expect(shelf).toEqual({
      id: 'technical-how-gezel-works',
      name: 'How Gezel works',
      parentId: 'technical',
      sortKey: topicSortKeyForOrder(1),
    });

    const docs = new Map(source.documents.map((d) => [d.id, d]));
    expect([...docs.keys()].sort()).toEqual([
      'architecture',
      'craftbooks',
      'the-crew',
      'welcome',
      'whats-new/1.26234',
    ]);
    expect(docs.get('welcome')?.ordinal).toBe(1);
    expect(docs.get('whats-new/1.26234')?.ordinal).toBe(-26234);
    expect(docs.get('welcome')?.meta).toEqual({ ogHeadline: 'The front door', siteVisible: true });
    expect(docs.get('the-crew')?.meta).toBeUndefined();
    expect(docs.get('craftbooks')?.topicPath).toEqual(['technical', 'technical-how-gezel-works']);
    expect(docs.get('craftbooks')?.aliases).toEqual(['recipes', 'playbooks']);
    expect(docs.get('welcome')?.summary).toBe('Start here.');
  });

  it('rewrites images to assets and article links to knowledge references', async () => {
    const warnings: string[] = [];
    const source = await loadMarkdownCatalog(root, {
      language: 'en',
      ignore: ['README.md'],
      uri: { publisherId: 'bendyline', catalogId: 'gezel-handboek' },
      onWarning: (message) => warnings.push(message),
    });
    const welcome = source.documents.find((d) => d.id === 'welcome')?.markdown ?? '';
    expect(welcome).toContain('![mark](assets/mark.png)');
    expect(welcome).toContain('[the crew](knowledge://bendyline/gezel-handboek/the-crew)');
    expect(welcome).toContain('[craftbooks](knowledge://bendyline/gezel-handboek/craftbooks)');
    expect(welcome).toContain('[the spec](https://example.com/spec)');
    expect(welcome).toContain('[outside](../../elsewhere.md)');
    expect(welcome).toContain('Not rewritten: [the crew](the-crew.md)');
    expect(warnings.some((w) => w.includes('elsewhere.md'))).toBe(true);
    const craftbooks = source.documents.find((d) => d.id === 'craftbooks')?.markdown ?? '';
    expect(craftbooks).toContain('![flow](assets/technical/img/flow.png)');
    expect(source.assets.map((a) => a.path)).toEqual([
      'assets/mark.png',
      'assets/technical/img/flow.png',
    ]);
    expect(source.assets[0]?.absPath).toBe(join(root, 'assets', 'mark.png'));
  });

  it('leaves article links alone without a catalog identity', async () => {
    const source = await loadMarkdownCatalog(root, { language: 'en', ignore: ['README.md'] });
    const welcome = source.documents.find((d) => d.id === 'welcome')?.markdown ?? '';
    expect(welcome).toContain('[the crew](the-crew.md#roster)');
    expect(welcome).toContain('![mark](assets/mark.png)');
  });

  it('refuses a missing image by default and warns when asked to', async () => {
    const tree = await mkdtemp(join(tmpdir(), 'gezk-missing-image-'));
    try {
      await writeFile(join(tree, 'a.md'), '# A\n\n![x](nope.png)\n');
      await expect(loadMarkdownCatalog(tree, { language: 'en' })).rejects.toThrow(
        /does not exist in the catalog tree/,
      );
      const warnings: string[] = [];
      const source = await loadMarkdownCatalog(tree, {
        language: 'en',
        missingAssets: 'warn',
        onWarning: (m) => warnings.push(m),
      });
      expect(source.documents[0]?.markdown).toContain('![x](nope.png)');
      expect(warnings).toHaveLength(1);
    } finally {
      await rm(tree, { recursive: true, force: true });
    }
  });

  it('refuses id collisions, bad ids, bad orders, and conflicting shelves', async () => {
    const tree = await mkdtemp(join(tmpdir(), 'gezk-bad-frontmatter-'));
    try {
      await writeFile(join(tree, 'a.md'), '---\nid: same\n---\n# A\n');
      await writeFile(join(tree, 'b.md'), '---\nid: same\n---\n# B\n');
      await expect(loadMarkdownCatalog(tree, { language: 'en' })).rejects.toThrow(
        /document id 'same' is already used by a.md/,
      );
      await rm(join(tree, 'b.md'));
      await writeFile(join(tree, 'c.md'), '---\nid: "a\\tb"\n---\n# C\n');
      await expect(loadMarkdownCatalog(tree, { language: 'en' })).rejects.toThrow(
        /not a valid document id/,
      );
      await rm(join(tree, 'c.md'));
      await writeFile(join(tree, 'd.md'), '---\norder: 1.5\n---\n# D\n');
      await expect(loadMarkdownCatalog(tree, { language: 'en' })).rejects.toThrow(/int32/);
      await rm(join(tree, 'd.md'));
      await writeFile(
        join(tree, 'e.md'),
        '---\nsubcategory:\n  id: shelf\n  title: Shelf\n  order: 1\n---\n# E\n',
      );
      await writeFile(
        join(tree, 'f.md'),
        '---\nsubcategory:\n  id: shelf\n  title: Other\n  order: 1\n---\n# F\n',
      );
      await expect(loadMarkdownCatalog(tree, { language: 'en' })).rejects.toThrow(
        /declared with a different title or order/,
      );
    } finally {
      await rm(tree, { recursive: true, force: true });
    }
  });

  it('is deterministic', async () => {
    const opts = { language: 'en', ignore: ['README.md'] };
    const a = await loadMarkdownCatalog(root, opts);
    const b = await loadMarkdownCatalog(root, opts);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
