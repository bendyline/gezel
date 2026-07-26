import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findHandboekContent, loadCuratedArticles, parseCuratedArticle } from './content.js';

describe('parseCuratedArticle', () => {
  it('reads frontmatter fields and keeps the body', () => {
    const source = [
      '---',
      'id: role/meester',
      'title: The Meester',
      'order: 1',
      'summary: The guildmaster.',
      'defaultDuration: 7',
      '---',
      '',
      '# The Meester',
      '',
      'Body.',
    ].join('\n');
    const article = parseCuratedArticle(source, 'gezel-roles', 'role-meester.md');
    expect(article).toMatchObject({
      id: 'role/meester',
      area: 'gezel-roles',
      title: 'The Meester',
      order: 1,
      summary: 'The guildmaster.',
      defaultDuration: 7,
      siteVisible: true,
    });
    expect(article?.body).toContain('# The Meester');
  });

  it('defaults id to the filename stem and title to the first heading', () => {
    const article = parseCuratedArticle(
      '# Welcome {[titleBlock]}\n\nHi.',
      'conceptual',
      'welcome.md',
    );
    expect(article).toMatchObject({ id: 'welcome', title: 'Welcome', order: 999 });
  });

  it('honors siteVisible: false and skips empty bodies', () => {
    const hidden = parseCuratedArticle(
      '---\nsiteVisible: false\n---\n\nBody.',
      'technical',
      'x.md',
    );
    expect(hidden?.siteVisible).toBe(false);
    expect(parseCuratedArticle('---\ntitle: Empty\n---\n', 'technical', 'y.md')).toBeNull();
  });
});

describe('content tree resolution', () => {
  let dir: string | undefined;

  afterEach(async () => {
    delete process.env.GEZEL_HANDBOEK_DIR;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('GEZEL_HANDBOEK_DIR overrides probing and loadCuratedArticles reads areas', async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-handboek-'));
    await mkdir(join(dir, 'conceptual'), { recursive: true });
    await mkdir(join(dir, 'technical'), { recursive: true });
    await writeFile(
      join(dir, 'conceptual', 'b.md'),
      '---\ntitle: Second\norder: 2\n---\n\nTwo.',
      'utf8',
    );
    await writeFile(
      join(dir, 'conceptual', 'a.md'),
      '---\ntitle: First\norder: 1\n---\n\nOne.',
      'utf8',
    );
    await writeFile(join(dir, 'technical', 'broken.md'), '---\ntitle: Empty\n---\n', 'utf8');
    process.env.GEZEL_HANDBOEK_DIR = dir;
    expect(findHandboekContent()).toBe(dir);
    const articles = loadCuratedArticles(dir);
    expect(articles.map((a) => a.id)).toEqual(['a', 'b']);
    expect(articles[0]).toMatchObject({ area: 'conceptual', title: 'First' });
  });

  it('finds the repo docs/handboek tree when no override is set', () => {
    delete process.env.GEZEL_HANDBOEK_DIR;
    const found = findHandboekContent();
    expect(found).toBeTruthy();
    const articles = loadCuratedArticles(found!);
    expect(articles.some((a) => a.id === 'welcome')).toBe(true);
    expect(articles.some((a) => a.id === 'role/meester')).toBe(true);
  });
});
